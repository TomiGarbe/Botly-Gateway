// P0.3-B1.3: delimitación de <(…), >(…) y $(…) en la lectura léxica. Antes, el cierre se buscaba
// contando paréntesis carácter por carácter: un ')' en un comentario (`<(echo # )`), en un patrón
// de case (`<(case a in a) …;; esac)`) o en el cuerpo de un heredoc (`<(cat <<E\n)\nE\n…)`) cerraba
// la sustitución antes de tiempo y los comandos siguientes quedaban fuera del análisis (o dentro del
// cuerpo del heredoc exterior). Ahora el cierre se busca con el tokenizador léxico (comillas,
// escapes, comentarios, heredocs, anidamiento, subshells y patrones de case) y el cuerpo se relee.
// Se valida AST real, IR, decide() y guard.mjs. Las pruebas exigen la regla sobre el archivo
// protegido (H-10/H-12 con su motivo) o un H-13 estructural: el vocabulario sensible no alcanza.
// Ningún comando se ejecuta: sólo se analizan sus textos.
import './env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseBash } from '../lib/bash.mjs';
import { decide } from '../lib/decide.mjs';
import { makeFixture } from './fixture.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = makeFixture();
const froot = root.split('\\').join('/');
const DOC = 'docs/MODULO_02_HANDOFF.md';
const show = (cmd) => JSON.stringify(cmd.replaceAll(froot, '<FROOT>'));

const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const allRedirects = (p) => [...p.commands.flatMap((c) => c.redirects), ...p.orphanRedirects];
const named = (p, name) => p.commands.filter((c) => c.words[0]?.text === name);
const VOCAB_MSG = /toca algo sensible|junto a un intérprete|vocabulario sensible/;
const structuralH13 = (r) => r.all.some((x) => x.rule === 'H-13' && !VOCAB_MSG.test(x.msg));
const PROTECTED = { 'H-12': /control protegido/, 'H-10': /skip-worktree/ };
const hits = (r, rule) => r.all.some((x) => x.rule === rule && PROTECTED[rule].test(x.msg));
const cpTo = (p, t) => p.commands.some((c) => c.words[0]?.text === 'cp' && c.words[2]?.text === t);

// ---------- AST real ----------
const vendor = (p) => path.join(HOOKS, 'vendor', p);
const ts = await import(pathToFileURL(vendor('web-tree-sitter/web-tree-sitter.js')).href);
await ts.Parser.init({ locateFile: () => vendor('web-tree-sitter/web-tree-sitter.wasm') });
const parser = new ts.Parser();
parser.setLanguage(await ts.Language.load(vendor('tree-sitter-bash/tree-sitter-bash.wasm')));
const ast = (src, fn) => { const t = parser.parse(src); try { return fn(t.rootNode); } finally { t.delete(); } };

const CRITICAL = [
  ["{ cat <<'X' 1<>out.txt; cat <(echo # )\ncp out.txt CLAUDE.md\n); }", 'CLAUDE.md'],
  ["{ cat <<'X' 1<>out.txt; cat <(case a in a) cp out.txt .claude/settings.json;; esac); }", '.claude/settings.json'],
  ["{ cat <<'X' 1<>out.txt; cat <(cat <<E\n)\nE\ncp out.txt .git/config); }", '.git/config'],
];

test('AST: en los casos críticos tree-sitter tiene ERROR y no representa el cp interno', () => {
  for (const [cmd] of CRITICAL) {
    ast(cmd, (r) => {
      assert.equal(r.hasError, true, cmd);
      assert.equal(r.descendantsOfType('command').some((c) => c.text.startsWith('cp ')), false, cmd);
    });
  }
});

// Control: un balanceo carácter por carácter (el mecanismo anterior) cierra antes del cp.
function naiveClose(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j++; continue; }
    if (ch === "'") { j = src.indexOf("'", j + 1); continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return j;
  }
  return -1;
}
test('control: el balanceo carácter por carácter cierra antes del cp; la lectura nueva lo recupera', async () => {
  for (const [cmd, t] of CRITICAL) {
    const open = cmd.indexOf('<(') + 1;
    assert.ok(naiveClose(cmd, open) < cmd.indexOf('cp out.txt'), cmd);
    const p = await parseBash(cmd);
    const cp = p.recovered.commands.find((c) => c.words[0]?.text === 'cp');
    assert.ok(cp, cmd);
    assert.equal(cp.subst, '<()');
    assert.equal(cp.substDepth, 1);
    assert.equal(cp.words[2].text, t);
    assert.ok(cmd.slice(cp.start).startsWith('cp out.txt'), 'posición traducida al texto original');
  }
});

// ---------- 1. Casos críticos ----------
for (const [cmd, t] of CRITICAL) {
  for (const c of [cmd, `${cmd}\nc\nX`]) {
    test(`crítico ${show(c)} => deny H-12 sobre ${t}`, async () => {
      const r = await run(c);
      assert.equal(r.decision, 'deny', JSON.stringify(r));
      assert.ok(hits(r, 'H-12'), JSON.stringify(r.all));
      assert.ok(cpTo(await parseBash(c), t));
    });
  }
}

// ---------- 2. Matriz: construcción × envoltura × destino ----------
const CONSTRUCTS = [
  ['comentario con )', (C) => `echo # )\n${C}\n`],
  ['comentario con ( ) ((', (C) => `echo # ( ) ((\n${C}\n`],
  ['case', (C) => `case a in a) ${C};; esac`],
  ['case (a)', (C) => `case a in (a) ${C};; esac`],
  ['case b|a)', (C) => `case a in b|a) ${C};; esac`],
  ['case ;& ;;&', (C) => `case a in b) echo;; a) ${C};& c) echo;;& esac`],
  ['case sin ;; final', (C) => `case a in a) ${C}\nesac`],
  ['case anidado', (C) => `case a in a) case b in b) ${C};; esac;; esac`],
  ["case ')'", (C) => `case ')' in ')') ${C};; esac`],
  ['case \\)', (C) => `case a in \\)) ${C};; esac`],
  ['case multilínea', (C) => `case a\nin\na)\n${C}\n;;\nesac`],
  ['heredoc', (C) => `cat <<E\n)\nE\n${C}`],
  ["heredoc 'E'", (C) => `cat <<'E'\n) # (\nE\n${C}`],
  ['heredoc "E"', (C) => `cat <<"E"\n) ((\nE\n${C}`],
  ['heredoc \\E', (C) => `cat <<\\E\n)\nE\n${C}`],
  ['heredoc <<-', (C) => `cat <<-E\n\t)\n\tE\n${C}`],
  ['varios heredocs', (C) => `cat <<A <<-B\n)\nA\n\t)\n\tB\n${C}`],
  ['delimitador repetido', (C) => `cat <<E; cat <<E\n)\nE\n)\nE\n${C}`],
  ['heredoc con operadores', (C) => `cat <<E\n( ; | & # ) ((\nE\n${C}`],
  ['case + heredoc + comentario', (C) => `case a in a) cat <<E\n) # (\nE\n${C};; esac # )\n`],
  ['<( ) anidada con case', (C) => `cat <(case a in a) ${C};; esac)`],
  ['$( ) anidada con case', (C) => `echo $(case a in a) ${C};; esac)`],
  ['`…`', (C) => `echo \`${C}\``],
  ['comillas con ) y #', (C) => `echo ')' "#" ')(' "(" ; ${C}`],
  ['escapes \\) \\#', (C) => `echo \\) \\# \\( ; ${C}`],
  ['pipeline', (C) => `echo x | ${C}`],
  ['bloque', (C) => `{ ${C}; }`],
  ['subshell', (C) => `(cd x; ${C})`],
  ['if', (C) => `if true; then ${C}; fi`],
  ['comandos antes y después', (C) => `echo a; ${C}; echo b`],
];
const WRAPS = [
  ['cat <(…)', (b) => `{ cat <<'X' 1<>out.txt; cat <(${b}); }`],
  ['diff <(echo a) <(…)', (b) => `{ cat <<'X' 1<>out.txt; diff <(echo a) <(${b}); }`],
  ['tee >(…)', (b) => `{ cat <<'X' 1<>out.txt; tee >(${b}); }`],
  ['antes/después + pipeline', (b) => `{ cat <<'X' 1<>out.txt; echo a; cat <(${b}) | wc -l; echo b; }`],
  ['con cuerpo del heredoc exterior', (b) => `{ cat <<'X' 1<>out.txt; cat <(${b}); }\nc\nX`],
  ['sin bloque', (b) => `cat <(${b})`],
];
const TARGETS = [
  ['CLAUDE.md', "C''LAUDE.md", 'H-12'],
  ['.claude/settings.json', ".cl''aude/settings.json", 'H-12'],
  ['.git/config', ".g''it/config", 'H-12'],
  [DOC, "d''ocs/MODULO_02_HANDOFF.md", 'H-10'],
];
for (const [kn, kf] of CONSTRUCTS) {
  for (const [wn, wf] of WRAPS) {
    test(`matriz ${kn} en ${wn}: el comando interno se recupera y se bloquea con su regla`, async () => {
      for (const [t, quoted, rule] of TARGETS) {
        for (const [written, resolved] of [[t, t], [`${froot}/${t}`, `${froot}/${t}`], [quoted, t]]) {
          const cmd = wf(kf(`cp out.txt ${written}`));
          const r = await run(cmd);
          assert.equal(r.decision, 'deny', show(cmd));
          assert.ok(hits(r, rule), `${rule} ${show(cmd)} ${JSON.stringify(r.all)}`);
          assert.ok(cpTo(await parseBash(cmd), resolved), `IR ${show(cmd)}`);
        }
      }
    });
  }
}

// ---------- 3. Casos legítimos ----------
const LEGIT = [
  'diff <(sort a) <(sort b)',
  'diff <(echo a) <(echo b)',
  "cat <(printf '%s\\n' hello)",
  'diff <(echo a # )\n) <(case a in a) echo ok;; esac)',
  'cat <(cat <<E\n)\nE\n)',
  'cat <(cat <<-E\n\t) ( #\n\tE\n)',
  'diff <(echo a#b) out.txt',
  'diff <(echo \\) \\#) out.txt',
  'cat <(case $x in uptime) echo uno;; whoami) echo dos;; esac)',
  'diff <(echo $(echo ")")) <(echo `echo "("`)',
  'echo a >(cat)',
];
// Contextos: árbol sin ERROR, y con ERROR en otra línea (la lectura léxica relee todo el texto).
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
      const p = await parseBash(cmd);
      const ws = allRedirects(p).filter((x) => x.write && !x.alternative).map((x) => x.target?.text);
      assert.ok(ws.every((x) => x === 'out.txt'), JSON.stringify(ws));
      // Patrones de case no son comandos.
      assert.equal(named(p, 'uptime').length + named(p, 'whoami').length, 0);
      assert.equal(p.recovered.ambiguous.length, 0);
    });
  }
}

test('IR: palabras de patrón, sujeto e `in` de case no son comandos (sus sustituciones sí se releen)', async () => {
  // Con ERROR, `git`/`rm` en el texto disparan además el H-13 por vocabulario de la política; acá
  // sólo se verifica que la lectura léxica no los convierte en comandos.
  const p = await parseBash("cat <<'X' 0>out.txt\nc\nX\ncat <(case $x\nin\ngit|rm) echo uno;; (sudo) echo dos;; esac)");
  for (const n of ['git', 'rm', 'sudo', 'in']) assert.equal(named(p, n).length, 0, n);
  assert.equal(named(p, 'echo').length, 2);
  const q = await parseBash(`{ cat <<'X' 1<>out.txt; cat <(case a in $(cp out.txt ${DOC})) echo;; esac); }`);
  assert.ok(cpTo(q, DOC), 'sustitución dentro de un patrón');
});

test('<( ) y >( ) no son redirecciones convencionales', async () => {
  let p = await parseBash("{ cat <<'X' 1<>out.txt; cat <(case a in a) echo;; esac) <(echo # )\n); }");
  const cat = p.recovered.commands.find((c) => c.words[0]?.text === 'cat');
  assert.equal(cat.redirects.length, 0);
  assert.equal(cat.words.length, 3);
  assert.ok(cat.words.slice(1).every((w) => w.text === null));
  p = await parseBash("{ cat <<'X' 1<>out.txt; tee >(case a in a) cat;; esac); }");
  const tee = p.recovered.commands.find((c) => c.words[0]?.text === 'tee');
  assert.equal(tee.redirects.length, 0);
  assert.ok(p.recovered.commands.some((c) => c.subst === '>()' && c.words[0]?.text === 'cat'));
});

// ---------- 4. No delimitable con certeza: H-13 estructural ----------
const P = (s) => `{ cat <<'X' 1<>out.txt; ${s}; }`;
for (const [cmd, why] of [
  [P('cat <(cat <<E)'), /heredoc sin cuerpo/],
  [P('cat <(case a in a) cp out.txt out2.txt'), /sustitución de proceso sin cerrar/],
  [P('cat <(case a in a) x;; )'), /sustitución de proceso sin cerrar/],
  [P('cat <(echo # )'), /sustitución de proceso sin cerrar/],
  [P('cat <(cat <<E\n)\nE)'), /sustitución de proceso sin cerrar/],
  [P('diff <(echo a) <(case a in a) x;;'), /sustitución de proceso sin cerrar/],
  [P('tee >(echo "a)'), /sustitución de proceso/],
  [P('echo $(case a in a) x;; )'), /sustitución de comandos sin cerrar/],
  [P(`cat ${'<(cat '.repeat(40)}x${')'.repeat(40)}`), /demasiado profundas/],
]) {
  test(`no delimitable ${show(cmd)} => deny H-13 estructural`, async () => {
    const p = await parseBash(cmd);
    assert.ok(p.recovered.ambiguous.some((a) => why.test(a.why)), JSON.stringify(p.recovered.ambiguous));
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(structuralH13(r), JSON.stringify(r.all));
  });
}

// ---------- 5. stdin, pipelines, origen y deduplicación ----------
test('stdin dentro de la sustitución: pipe interno, heredoc interno y heredado', async () => {
  let cmd = P('cat <(echo x | bash)');
  let p = await parseBash(cmd);
  const bash = p.recovered.commands.find((c) => c.words[0]?.text === 'bash');
  assert.equal(bash.subst, '<()');
  assert.equal(bash.stdin.kind, 'dynamic');
  assert.match(bash.stdin.via, /pipe/);
  const r = await run(cmd);
  assert.ok(r.all.some((x) => x.rule === 'H-13' && /bash recibe por stdin código no literal/.test(x.msg)), JSON.stringify(r.all));
  cmd = P('cat <(cat <<E\n) hola (\nE\n)');
  p = await parseBash(cmd);
  const inner = p.recovered.commands.find((c) => c.subst === '<()' && c.words[0]?.text === 'cat');
  assert.equal(inner.stdin.kind, 'literal');
  assert.equal(inner.stdin.text, ') hola (\n');
  p = await parseBash(P('tee >(case a in a) cat;; esac)'));
  assert.equal(p.recovered.commands.find((c) => c.subst === '>()').stdin.kind, 'dynamic');
});

test('origen: tipo y nivel de sustitución, y posiciones en el texto original', async () => {
  // Sólo la lectura léxica ve estos cp (el AST no los representa): nivel 2 de <( ).
  for (const cmd of [P(`cat <(cat <(case a in a) cp out.txt ${DOC};; esac))`), P(`cat <(cat <(echo # )\ncp out.txt ${DOC}\n))`)]) {
    const p = await parseBash(cmd);
    assert.equal(named(p, 'cp').length, 1, 'sin duplicados');
    const lex = p.recovered.commands.find((c) => c.words[0]?.text === 'cp');
    assert.equal(lex.subst, '<()');
    assert.equal(lex.substDepth, 2);
    assert.ok(cmd.slice(lex.start).startsWith('cp out.txt'));
    assert.ok(hits(await run(cmd), 'H-10'));
  }
  // Mezcla <( $( ) ) con comentario: el AST ya lo representa y la copia léxica no se duplica.
  const cmd = P(`cat <(echo $(case a in a) cp out.txt ${DOC};; esac) # )\n)`);
  assert.equal(named(await parseBash(cmd), 'cp').length, 1);
  assert.ok(hits(await run(cmd), 'H-10'));
});

test('lo que el AST ya representa no se duplica', async () => {
  for (const cmd of [`cat <(cp out.txt ${DOC})\n{ cat <<'X' 1<>out.txt; }`, P(`cat <(case a in a) cp out.txt ${DOC};; esac)`)]) {
    const p = await parseBash(cmd);
    assert.equal(p.hasError, true);
    assert.equal(p.commands.filter((c) => c.words[0]?.text === 'cp').length, 1, cmd);
  }
});

// ---------- 6. guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  ...CRITICAL.map(([c]) => [c, 2, 'H-1[23]']),
  [P(`diff <(echo a) <(case a in a) cp out.txt ${DOC};; esac)`), 2, 'H-10'],
  ['diff <(echo a # )\n) <(case a in a) echo ok;; esac)', 0],
]) {
  test(`procsub guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
