// P0.3-B1.5: comandos (simples y compuestos) después de `coproc` y `time`. tree-sitter-bash no
// conoce esas palabras reservadas: las toma como nombre de programa y lo que sigue (`{`, `if`,
// `while`, el comando del coproc) como argumentos, sin nodos ERROR. La política desenvuelve `time`
// pero no `coproc`, y el lector léxico (que sólo corría con ERROR o `case`) descartaba todo
// `coproc` simple. Resultado: `coproc cp … DOC` o `time -p { cp … DOC; }` daban allow.
// Ahora la relectura léxica corre también cuando un comando del AST se llama `time` o `coproc`, el
// lector nunca toma `coproc` como programa, y los comandos de un coproc reciben como stdin el pipe
// que escribe el shell. Se valida AST real, IR, decide() y guard.mjs. Ningún comando se ejecuta.
import './env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseBash } from '../lib/bash.mjs';
import { decide } from '../lib/decide.mjs';
import { matrix } from './coproc-time-matrix.mjs';
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
// El AST representa `time [-p] [--] cp …` como un comando `time` (la política lo desenvuelve).
const unTime = (ws) => { let k = 0; if (ws[k]?.text === 'time') { k++; if (ws[k]?.text === '-p') k++; if (ws[k]?.text === '--') k++; } return ws.slice(k); };
const isCp = (c) => unTime(c.words)[0]?.text === 'cp';
const cpTo = (p, t) => p.commands.some((c) => isCp(c) && unTime(c.words)[2]?.text === t);
const progs = (p) => p.commands.map((c) => c.words[0]?.text);

// ---------- AST real ----------
const vendor = (p) => path.join(HOOKS, 'vendor', p);
const ts = await import(pathToFileURL(vendor('web-tree-sitter/web-tree-sitter.js')).href);
await ts.Parser.init({ locateFile: () => vendor('web-tree-sitter/web-tree-sitter.wasm') });
const parser = new ts.Parser();
parser.setLanguage(await ts.Language.load(vendor('tree-sitter-bash/tree-sitter-bash.wasm')));
const ast = (src, fn) => { const t = parser.parse(src); try { return fn(t.rootNode); } finally { t.delete(); } };

// ---------- 1. Reproducciones exactas ----------
const REPORT = [
  'coproc cp out.txt docs/MODULO_02_HANDOFF.md',
  'coproc N { cp out.txt docs/MODULO_02_HANDOFF.md; }',
  'time -p { cp out.txt docs/MODULO_02_HANDOFF.md; }',
  'time -p if true; then cp out.txt docs/MODULO_02_HANDOFF.md; fi',
];

test('AST: sin ERROR, tree-sitter toma coproc/time como programa y el cp no es un comando propio', () => {
  for (const cmd of REPORT) {
    ast(cmd, (r) => {
      assert.equal(r.hasError, false, cmd);
      const names = r.descendantsOfType('command').map((c) => c.namedChildren.find((x) => x.type === 'command_name')?.text);
      assert.ok(names[0] === 'coproc' || names[0] === 'time', `${cmd}: ${names}`);
      assert.ok(!names.includes('cp'), `${cmd}: ${names}`);
    });
  }
});

for (const cmd of REPORT) {
  for (const c of [cmd, `{ cat <<'X' 1<>out.txt; ${cmd}; }`, `( ${cmd} )`, `echo "$(${cmd})"`]) {
    test(`informe ${show(c)} => deny H-10`, async () => {
      const r = await run(c);
      assert.equal(r.decision, 'deny', JSON.stringify(r));
      assert.ok(hits(r, 'H-10'), JSON.stringify(r.all));
      const p = await parseBash(c);
      const cps = p.commands.filter((x) => isCp(x) && x.words[2]?.text === DOC);
      assert.equal(cps.length, 1, 'un solo cp en la IR (sin duplicados)');
      assert.ok(c.slice(cps[0].start ?? c.indexOf('cp out.txt')).startsWith('cp out.txt'), 'posición en el texto original');
    });
  }
}

// ---------- 2. Matriz adversarial ----------
const M = matrix(froot);
test('matriz: tamaño esperado', () => assert.ok(M.length >= 440, String(M.length)));
for (const [name, cmd, t, rule] of M) {
  test(`matriz ${name} ${show(cmd)} => deny ${rule}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(hits(r, rule), JSON.stringify(r.all));
    assert.ok(cpTo(await parseBash(cmd), t), `cp a ${t} en la IR`);
  });
}

// ---------- 3. Reconstrucción: todos los comandos internos, sin falsos comandos ----------
test('IR: cada comando ejecutable del compuesto aparece; coproc, NOMBRE, time y sus opciones no son programas', async () => {
  for (const [cmd, want] of [
    ['coproc N { date; uname; }', ['date', 'uname']],
    ['coproc N ( date; uname )', ['date', 'uname']],
    ['coproc { date | uname; } | wc', ['date', 'uname', 'wc']],
    ['time -p if date; then uname; else hostname; fi', ['date', 'uname', 'hostname']],
    ['time -- while date; do uname; break; done', ['date', 'uname']],
    ['! time -p for i in 1; do date; done', ['date']],
    ['time -p coproc N { date; }', ['date']],
    ['coproc x=1 date', ['date']],
    ['coproc >/dev/null date', ['date']],
    ['coproc date; uname', ['date', 'uname']],
  ]) {
    for (const c of [cmd, `{ cat <<'X' 1<>out.txt; ${cmd}; }`]) {
      const p = await parseBash(c);
      const lex = p.recovered.commands.map((x) => x.words[0]?.text);
      for (const w of want) assert.ok(progs(p).includes(w), `${c}: falta ${w} en ${progs(p)}`);
      for (const bad of ['coproc', 'N', 'time', '-p', '--', '{', '}', 'if', 'then', 'do', 'x=1']) assert.ok(!lex.includes(bad), `${c}: ${lex}`);
      assert.equal(p.recovered.ambiguous.length, 0, `${c}: ${JSON.stringify(p.recovered.ambiguous)}`);
    }
  }
});

test('IR: stdin de los comandos de un coproc es el pipe del shell; el resto conserva el suyo', async () => {
  let p = await parseBash('coproc cat; echo b');
  const cat = p.commands.find((c) => c.words[0]?.text === 'cat');
  assert.equal(cat.stdin.kind, 'dynamic');
  assert.match(cat.stdin.via, /coproc/);
  assert.equal(p.commands.find((c) => c.words[0]?.text === 'echo').stdin.kind, 'none');
  // Pipeline: `coproc a | b` -> b lee del pipe de a, no del coproc.
  p = await parseBash('coproc { date; } | wc; uname');
  assert.match(p.commands.find((c) => c.words[0]?.text === 'date').stdin.via, /coproc/);
  assert.equal(p.commands.find((c) => c.words[0]?.text === 'uname').stdin.kind, 'none');
  // Stdin propio (heredoc / here-string) gana.
  p = await parseBash('coproc { cat <<E; }\nhola\nE');
  assert.equal(p.commands.find((c) => c.lexical && c.words[0]?.text === 'cat').stdin.kind, 'literal');
  // Lo que el AST ya representaba (subshell) recibe el stdin del coproc en lugar de duplicarse.
  p = await parseBash('coproc N ( cat )');
  const cats = p.commands.filter((c) => c.words[0]?.text === 'cat');
  assert.equal(cats.length, 1);
  assert.match(cats[0].stdin.via ?? '', /coproc/);
  // time no cambia el stdin.
  p = await parseBash('time -p { cat; }');
  assert.equal(p.commands.find((c) => c.words[0]?.text === 'cat').stdin.kind, 'none');
});

test('dedup: `time [-p] [--] cmd` del AST no se duplica con la lectura léxica', async () => {
  for (const cmd of ['time -p ls', 'time ls -la', 'time -- ls', 'time -p -- ls', '! time -p ls']) {
    const p = await parseBash(cmd);
    assert.equal(p.recovered.commands.length, 0, `${cmd}: ${JSON.stringify(p.recovered.commands.map((c) => c.words.map((w) => w.text)))}`);
  }
  // coproc sí se agrega: la política no desenvuelve coproc, así que el AST no lo representa igual.
  const p = await parseBash('coproc ls');
  assert.deepEqual(p.recovered.commands.map((c) => c.words.map((w) => w.text)), [['ls']]);
});

// ---------- 4. Intérpretes en un coproc: leen código del pipe del shell ----------
for (const cmd of ['coproc bash', 'coproc N { sh; }', 'time -p coproc python3', 'coproc ( bash )']) {
  test(`intérprete en coproc ${show(cmd)} => H-13 (stdin no literal)`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(r.all.some((x) => x.rule === 'H-13' && /stdin/.test(x.msg)), JSON.stringify(r.all));
  });
}

// ---------- 5. Legítimos ----------
const LEGIT = [
  'coproc cat',
  'coproc N { cat; }',
  'coproc N ( sleep 1 )',
  'coproc { while read -r l; do echo "$l"; done; }',
  'time -p ls',
  'time ls -la',
  'time -p -- ls',
  '! time -p true',
  'time -p { ls; echo ok; }',
  'time -p if true; then echo ok; fi',
  'time for i in 1 2; do echo $i; done',
  'time -p coproc cat',
  'echo coproc time',
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

// ---------- 6. Ambiguo / no reconstruible: falla cerrado ----------
for (const cmd of [
  `time -- -- { cp out.txt ${DOC}; }`,
  `! time -p -- -- if true; then cp out.txt ${DOC}; fi`,
]) {
  test(`ambiguo ${show(cmd)} => deny con H-13 estructural`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(structuralH13(r), JSON.stringify(r.all));
  });
}

// ---------- 7. guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  ...REPORT.map((c) => [c, 2, 'H-10']),
  ['coproc cat', 0],
  ['time -p { ls; }', 0],
]) {
  test(`coproc-time guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
