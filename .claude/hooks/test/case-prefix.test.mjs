// P0.3-B1.4: `case` después de `time`, `coproc` y `function`. Bash reconoce `case` como reservada
// después de `time -p`, `time [-p] --`, `! time -p`, `coproc`, `coproc NOMBRE`, `function NOMBRE` y
// `NOMBRE()`; el lector léxico de B1.3 sólo lo hacía en posición de comando "simple", y tree-sitter
// lo toma como un argumento y cierra la sustitución en el ')' del patrón, incluso sin nodos ERROR.
// Lo que seguía al ')' quedaba como texto (o fuera de la sustitución) y el cp no se analizaba.
// Ahora el tokenizador modela esos prefijos y la lectura léxica se hace también con árboles sin ERROR
// cuando el texto contiene la palabra `case`.
// Se valida AST real, IR, decide() y guard.mjs. Ningún comando se ejecuta: sólo se analizan sus
// textos (la validación con Bash real se hizo aparte, con equivalentes que sólo usan echo).
import './env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseBash } from '../lib/bash.mjs';
import { decide } from '../lib/decide.mjs';
import { matrix } from './case-prefix-matrix.mjs';
import { makeFixture } from './fixture.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = makeFixture();
const froot = root.split('\\').join('/');
const DOC = 'docs/MODULO_02_HANDOFF.md';
const show = (cmd) => JSON.stringify(cmd.replaceAll(froot, '<FROOT>'));

const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const VOCAB_MSG = /toca algo sensible|junto a un intérprete|vocabulario sensible/;
const structuralH13 = (r) => r.all.some((x) => x.rule === 'H-13' && !VOCAB_MSG.test(x.msg));
const PROTECTED = { 'H-12': /control protegido/, 'H-10': /skip-worktree/ };
const hits = (r, rule) => r.all.some((x) => x.rule === rule && PROTECTED[rule].test(x.msg));
const cpTo = (p, t) => p.commands.some((c) => c.words[0]?.text === 'cp' && c.words[2]?.text === t);
const cpCmd = (p) => p.commands.find((c) => c.words[0]?.text === 'cp');

// ---------- AST real ----------
const vendor = (p) => path.join(HOOKS, 'vendor', p);
const ts = await import(pathToFileURL(vendor('web-tree-sitter/web-tree-sitter.js')).href);
await ts.Parser.init({ locateFile: () => vendor('web-tree-sitter/web-tree-sitter.wasm') });
const parser = new ts.Parser();
parser.setLanguage(await ts.Language.load(vendor('tree-sitter-bash/tree-sitter-bash.wasm')));
const ast = (src, fn) => { const t = parser.parse(src); try { return fn(t.rootNode); } finally { t.delete(); } };

// ---------- 1. Reproducciones exactas del informe independiente ----------
const REPORT = [
  ["{ cat <<'X' 1<>out.txt; echo ${x:-$(time -p case a in a) echo;; esac; cp out.txt CLAUDE.md)}; }", 'CLAUDE.md', 'H-12', true],
  ["{ cat <<'X' 1<>out.txt; echo ${x:-$(coproc case a in a) echo;; esac; cp out.txt CLAUDE.md)}; }", 'CLAUDE.md', 'H-12', true],
  ["{ cat <<'X' 1<>out.txt; cat <(time -p case a in a) cp out.txt CLAUDE.md;; esac); }", 'CLAUDE.md', 'H-12', true],
  ['echo "$(function f case a in a) echo;; esac; f; cp out.txt docs/MODULO_02_HANDOFF.md)"', DOC, 'H-10', true],
  ['echo "$(time -p case a in a) echo;; esac; cp out.txt CLAUDE.md)"', 'CLAUDE.md', 'H-12', false],
  ['x="$(time -p case a in a) echo;; esac; cp out.txt CLAUDE.md)"', 'CLAUDE.md', 'H-12', false],
];

test('AST: tree-sitter no representa el cp de las reproducciones; dos de ellas no tienen ERROR', () => {
  for (const [cmd, , , err] of REPORT) {
    ast(cmd, (r) => {
      assert.equal(r.hasError, err, cmd);
      assert.equal(r.descendantsOfType('command').some((c) => c.text.startsWith('cp ')), false, cmd);
    });
  }
  // En los casos sin ERROR, `case` es un argumento del comando `time`.
  ast(REPORT[4][0], (r) => {
    const time = r.descendantsOfType('command').find((c) => c.text.startsWith('time'));
    assert.deepEqual(time.namedChildren.slice(1).map((c) => c.text), ['-p', 'case', 'a', 'in', 'a']);
  });
});

for (const [cmd, t, rule] of REPORT) {
  test(`informe ${show(cmd)} => deny ${rule} sobre ${t}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(hits(r, rule), JSON.stringify(r.all));
    const p = await parseBash(cmd);
    assert.ok(cpTo(p, t), 'el cp interno está en la IR');
    const cp = cpCmd(p);
    assert.equal(cp.lexical, true);
    assert.ok(cp.subst === '$()' || cp.subst === '<()', cp.subst);
    assert.ok(cmd.slice(cp.start).startsWith('cp out.txt'), 'posición traducida al texto original');
    // Nada posterior al cierre del case se pierde: también está el `echo`/`f` del cuerpo o de después.
    assert.ok(p.recovered.commands.length >= 1);
  });
}

// ---------- 2. Matriz: prefijo × envoltura y prefijo × cuerpo ----------
const M = matrix(froot);
test('matriz: tamaño esperado (cada prefijo y cada contexto relevante)', () => {
  assert.ok(M.length >= 600, String(M.length));
});
for (const [name, cmd, t, rule] of M) {
  test(`matriz ${name} ${show(cmd)} => deny ${rule}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(hits(r, rule), JSON.stringify(r.all));
    assert.ok(cpTo(await parseBash(cmd), t), `cp a ${t} en la IR`);
  });
}

// ---------- 3. Palabras reservadas y argumentos ----------
// `case` NO es reservada en estas posiciones (verificado con Bash 5.2): la sustitución cierra en el
// primer ')' y lo que sigue es un comando exterior, no de la sustitución.
const P = (s) => `{ cat <<'X' 1<>out.txt; ${s}; }`;
const NOT_RESERVED = [
  ['argumento de echo', 'echo case a in a'],
  ['después de `if` como argumento', 'echo if case a in a'],
  ['después de `then` como argumento', 'echo then case a in a'],
  ['después de `{` como argumento', 'echo { case a in a'],
  ['`time` después de |', 'true | time -p case a in a'],
  ['`time` después de |&', 'true |& time -p case a in a'],
  ['`time` después de | y salto de línea', 'true |\ntime -p case a in a'],
  ['`time` después de una asignación', 'x=1 time -p case a in a'],
  ['`\\time`', '\\time -p case a in a'],
  ['`t""ime`', 't""ime -p case a in a'],
  ['`time "-p"`', 'time "-p" case a in a'],
  ['`time -p -p`', 'time -p -p case a in a'],
  ['`time -- -p`', 'time -- -p case a in a'],
  ['`ca""se`', 'time -p ca""se a in a'],
  ['`\\case`', 'time -p \\case a in a'],
  ['`coproc NOMBRE time`', 'coproc N time case a in a'],
  ['`coproc ASIGNACIÓN`', 'coproc N=1 case a in a'],
  ['redirección antes', 'time -p >/dev/null case a in a'],
];
for (const [name, s] of NOT_RESERVED) {
  for (const cmd of [P(`cat <(${s}) ; cp out.txt CLAUDE.md`), `cat <(${s}) ; cp out.txt CLAUDE.md`]) {
    test(`no reservada (${name}) ${show(cmd)} => cp exterior, deny H-12`, async () => {
      const p = await parseBash(cmd);
      const cp = p.commands.filter((c) => c.words[0]?.text === 'cp' && c.words[2]?.text === 'CLAUDE.md');
      assert.ok(cp.length, 'cp en la IR');
      // Si sólo lo encontró el lector léxico, tiene que estar fuera de la sustitución.
      for (const c of cp.filter((x) => x.lexical)) assert.equal(c.subst, undefined, JSON.stringify(c));
      assert.equal(p.recovered.ambiguous.length, 0, JSON.stringify(p.recovered.ambiguous));
      const r = await run(cmd);
      assert.equal(r.decision, 'deny');
      assert.ok(hits(r, 'H-12'), JSON.stringify(r.all));
    });
  }
}

// Desplazamiento de comillas: si el lector abriera un case donde Bash no lo hace, el cp quedaría
// dentro de una palabra entre comillas de la sustitución. Bash lo ejecuta como comando exterior.
for (const cmd of [
  'echo "$(echo if case a in a)" ; cp out.txt CLAUDE.md ; echo "; esac)"',
  'echo "$(true | time -p case a in a)" ; cp out.txt CLAUDE.md ; echo "; esac)"',
  P('echo "$(echo if case a in a)" ; cp out.txt CLAUDE.md ; echo "; esac)"'),
  P('echo "$(true | time -p case a in a)" ; cp out.txt CLAUDE.md ; echo "; esac)"'),
]) {
  test(`comillas desplazadas ${show(cmd)} => deny H-12`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(hits(r, 'H-12'), JSON.stringify(r.all));
  });
}

test('IR: las palabras del prefijo no son el programa; el case compuesto no es un comando', async () => {
  for (const [cmd, progs] of [
    [P('cat <(time -p -- case a in a) echo;; esac; date)'), ['cat', 'echo', 'date']],
    [P('cat <(coproc NOMBRE case a in a) echo;; esac; date)'), ['cat', 'echo', 'date']],
    [P('cat <(coproc case a in a) echo;; esac; date)'), ['cat', 'echo', 'date']],
    [P('cat <(function f case a in a) echo;; esac; f; date)'), ['cat', 'echo', 'f', 'date']],
    [P('cat <(function f() case a in a) echo;; esac; f; date)'), ['cat', 'echo', 'f', 'date']],
    [P('cat <(! time -p case a in a) echo;; esac; date)'), ['cat', 'echo', 'date']],
  ]) {
    const p = await parseBash(cmd);
    const got = p.recovered.commands.map((c) => c.words[0]?.text);
    for (const bad of ['-p', '--', 'NOMBRE', 'case', 'function', 'coproc', 'time', 'a', 'in']) assert.ok(!got.includes(bad), `${cmd}: ${got}`);
    for (const want of progs.slice(1)) assert.ok(got.includes(want), `${cmd}: falta ${want} en ${got}`);
    assert.equal(p.recovered.ambiguous.length, 0, JSON.stringify(p.recovered.ambiguous));
  }
});

test('IR: origen, nivel y stdin de los comandos recuperados', async () => {
  let p = await parseBash('echo "$(echo "$(time -p case a in a) echo;; esac; cp out.txt CLAUDE.md)")"');
  let cp = cpCmd(p);
  assert.equal(cp.subst, '$()');
  assert.equal(cp.substDepth, 2);
  assert.equal(cp.stdin.kind, 'dynamic');
  p = await parseBash(P('cat <(time -p case a in a) echo x | cp out.txt CLAUDE.md;; esac)'));
  cp = cpCmd(p);
  assert.equal(cp.subst, '<()');
  assert.equal(cp.stdin.kind, 'dynamic');
  assert.match(cp.stdin.via, /pipe/);
  p = await parseBash(P('cat <(coproc case a in a) cp out.txt CLAUDE.md <<<hola;; esac)'));
  cp = cpCmd(p);
  assert.equal(cp.stdin.kind, 'literal'); // here-string propio, no el heredado
});

test('dedup: con árbol sin ERROR, lo que el AST ya representa no se duplica', async () => {
  const cmd = 'echo "$(time -p case a in a) echo;; esac; cp out.txt CLAUDE.md)"';
  const p = await parseBash(cmd);
  assert.equal(p.hasError, false);
  assert.equal(p.commands.filter((c) => c.words[0]?.text === 'echo' && !c.lexical).length, 1);
  assert.equal(p.recovered.commands.filter((c) => c.words[0]?.text === 'echo' && c.subst === undefined).length, 0, 'el echo exterior no se duplica');
  assert.equal(p.recovered.commands.filter((c) => c.words[0]?.text === 'cp').length, 1);
});

// ---------- 4. Casos legítimos ----------
const LEGIT = [
  'time -p ls',
  'time ls -la',
  'time -p -- ls',
  '! time -p true',
  'time -p case a in a) echo ok;; esac',
  'echo "$(time -p case a in a) echo ok;; esac)"',
  'x="$(time -p case "$1" in a) echo a;; *) echo b;; esac)"',
  'cat <(time -p case a in a) echo ok;; esac)',
  'diff <(sort a) <(sort b)',
  'echo "$(coproc case a in a) echo ok;; esac)"',
  'coproc NOMBRE { cat; }',
  'function f { echo hola; }; f',
  'function f case a in a) echo a;; esac',
  'f() case $1 in a) echo a;; esac',
  'echo time case in esac',
  'echo "case"',
  'for t in a b; do case $t in a) echo;; esac; done',
  'ls | time -p wc -l',
];
const LEGIT_CTX = [
  ['sin ERROR', (s) => s],
  ['con ERROR previo', (s) => `cat <<'X' 0>out.txt\nc\nX\n${s}`],
];
for (const s of LEGIT) {
  for (const [cn, cf] of LEGIT_CTX) {
    const cmd = cf(s);
    test(`legítimo ${cn} ${show(cmd)} => allow`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'allow', JSON.stringify(r));
    });
  }
}

// ---------- 5. Ambiguos: fallan cerrados (H-13 estructural) ----------
for (const [cmd, why] of [
  // Bash 5.2 acepta un segundo `--` en unos contextos y lo ejecuta como comando en otros.
  ['echo "$(time -- -- case a in a) echo;; esac; cp out.txt CLAUDE.md)"', /repetido/],
  ['echo "$(time -p -- -- case a in a) echo;; esac; cp out.txt CLAUDE.md)"', /repetido/],
  [P(`cat <(! time -- -- case a in a) cp out.txt ${DOC};; esac)`), /repetido/],
  // Con modo POSIX, `time -p` no es reservada (Bash interp. 267): hay dos lecturas.
  ['set -o posix\necho "$(time -p case a in a) echo;; esac; cp out.txt CLAUDE.md)"', /POSIX/],
  ['POSIXLY_CORRECT=1\necho "$(time -- case a in a) echo;; esac; cp out.txt CLAUDE.md)"', /POSIX/],
  [P(`set -o posix; cat <(time -p case a in a) cp out.txt ${DOC};; esac)`), /POSIX/],
  // Case sin esac antes del cierre.
  ['echo "$(time -p case a in a) cp out.txt CLAUDE.md)"', /sin cerrar|case sin esac/],
]) {
  test(`ambiguo ${show(cmd)} => H-13 estructural`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(structuralH13(r), JSON.stringify(r.all));
    const p = await parseBash(cmd);
    assert.ok(p.recovered.ambiguous.some((a) => why.test(a.why)), JSON.stringify(p.recovered.ambiguous));
  });
}

test('modo POSIX: la lectura en la que Bash ejecuta el cp afuera también se bloquea', async () => {
  const cmd = 'set -o posix\necho "$(time -p case a in a)" ; cp out.txt CLAUDE.md ; echo "; esac)"';
  const r = await run(cmd);
  assert.equal(r.decision, 'deny');
  assert.ok(hits(r, 'H-12'), JSON.stringify(r.all));
});

// ---------- 6. guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  ...REPORT.map(([c, , r]) => [c, 2, r]),
  ['echo "$(time -p case a in a) echo ok;; esac)"', 0],
  ['function f case a in a) echo a;; esac', 0],
]) {
  test(`case-prefix guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[(${rule}|H-13)\\]`));
    else assert.equal(r.stdout, '');
  });
}
