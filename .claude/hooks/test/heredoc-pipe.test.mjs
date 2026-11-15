// 2.2.3.3: heredoc seguido de pipeline (`cat <<X | bash`). tree-sitter-bash ubica el receptor DENTRO
// del heredoc_redirect; antes el receptor quedaba sin stdin y su programa no se analizaba.
// Se valida: el AST de tree-sitter, la IR de parseBash, decide() y el proceso real de guard.mjs.
// Ningún comando analizado se ejecuta.
import './env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseBash } from '../lib/bash.mjs';
import { decide } from '../lib/decide.mjs';
import { vendorPath, verifyVendor } from '../lib/vendor.mjs';
import { makeFixture } from './fixture.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = makeFixture();

// ---------- 1. AST de tree-sitter-bash (supuesto estructural del que depende la corrección) ----------
async function rawTree(text) {
  verifyVendor();
  const mod = await import(pathToFileURL(vendorPath('web-tree-sitter/web-tree-sitter.js')).href);
  await mod.Parser.init({ locateFile: () => vendorPath('web-tree-sitter/web-tree-sitter.wasm') });
  const lang = await mod.Language.load(vendorPath('tree-sitter-bash/tree-sitter-bash.wasm'));
  const p = new mod.Parser();
  p.setLanguage(lang);
  const t = p.parse(text);
  const sexp = (n) => (n.namedChildCount ? `(${n.type} ${n.namedChildren.map(sexp).join(' ')})` : n.type);
  const s = sexp(t.rootNode);
  t.delete();
  return s;
}

test('AST: el receptor del pipe queda dentro de heredoc_redirect', async () => {
  const s = await rawTree("cat <<'X' | bash\ngit status\nX");
  assert.match(s, /\(heredoc_redirect heredoc_start \(pipeline \(command \(command_name word\)\)\) heredoc_body heredoc_end\)/);
});

test('AST: delimitador sin comillas marca la expansión en el cuerpo; con comillas no', async () => {
  assert.match(await rawTree('cat <<X | bash\n$(id)\nX'), /heredoc_body \(command_substitution/);
  assert.doesNotMatch(await rawTree("cat <<'X' | bash\n$(id)\nX"), /command_substitution/);
});

test('AST: con 2>/dev/null tree-sitter no reconoce el pipeline (ERROR)', async () => {
  assert.match(await rawTree('cat <<X 2>/dev/null | bash\nb\nX'), /ERROR/);
});

// ---------- 2. IR de parseBash: receptor analizable, orden y stdin asociado ----------
const names = (ir) => ir.commands.map((c) => c.words[0]?.text);
const byName = (ir, n) => ir.commands.find((c) => c.words[0]?.text === n);

test('IR: receptor directo recibe el cuerpo literal (delimitador con comillas)', async () => {
  const ir = await parseBash("cat <<'X' | bash\ngit status\nX");
  assert.deepEqual(names(ir), ['cat', 'bash']);
  assert.deepEqual(byName(ir, 'bash').stdin, { kind: 'literal', text: 'git status\n', expands: false, via: 'heredoc-pipe' });
  assert.equal(byName(ir, 'cat').stdin.kind, 'literal'); // el dueño sigue leyendo el heredoc
  assert.equal(ir.heredocError, false);
});

test('IR: delimitador sin comillas con expansión -> literal con expands=true', async () => {
  const ir = await parseBash('cat <<X | node\nconsole.log($V)\nX');
  const st = byName(ir, 'node').stdin;
  assert.equal(st.kind, 'literal');
  assert.equal(st.expands, true);
});

test('IR: <<- y |& también asocian stdin', async () => {
  assert.equal(byName(await parseBash('cat <<-X | sh -s\n\tgit status\n\tX'), 'sh').stdin.kind, 'literal');
  assert.equal(byName(await parseBash('cat <<X |& bash\nb\nX'), 'bash').stdin.kind, 'literal');
});

test('IR: pipeline de más de un comando: el primero recibe el heredoc, el siguiente la salida de aquél', async () => {
  const ir = await parseBash('cat <<X | grep a | bash\nb\nX');
  assert.deepEqual(names(ir), ['cat', 'grep', 'bash']);
  assert.equal(byName(ir, 'grep').stdin.kind, 'literal');
  assert.equal(byName(ir, 'grep').stdin.text, 'b\n');
  assert.equal(byName(ir, 'bash').stdin.kind, 'dynamic');
  const ir2 = await parseBash('cat <<X | bash | tee f\nb\nX');
  assert.equal(byName(ir2, 'bash').stdin.kind, 'literal');
  assert.equal(byName(ir2, 'tee').stdin.kind, 'dynamic');
});

test('IR: subshell, bloque { }, redirección y lista', async () => {
  assert.equal(byName(await parseBash('cat <<X | (bash)\nb\nX'), 'bash').stdin.kind, 'literal');
  assert.equal(byName(await parseBash('cat <<X | { true; bash; }\nb\nX'), 'bash').stdin.kind, 'literal');
  assert.equal(byName(await parseBash('cat <<X | bash > out\nb\nX'), 'bash').stdin.kind, 'literal');
  const l = await parseBash('cat <<X | bash && echo ok\nb\nX');
  assert.equal(byName(l, 'bash').stdin.kind, 'literal');
  assert.equal(byName(l, 'echo').stdin.kind, 'none');
});

test('IR: && no es pipe; el dueño dentro de un pipeline; dueño que no copia el heredoc', async () => {
  assert.equal(byName(await parseBash('cat <<X && bash\nb\nX'), 'bash').stdin.kind, 'none');
  assert.equal(byName(await parseBash('a | cat <<X | bash\nb\nX'), 'bash').stdin.kind, 'literal');
  assert.equal(byName(await parseBash('cat foo.txt <<X | bash\nb\nX'), 'bash').stdin.kind, 'dynamic');
  const e = byName(await parseBash('echo hola <<X | bash\nb\nX'), 'bash').stdin;
  assert.equal(e.kind, 'literal');
  assert.equal(e.text, 'hola');
});

test('IR: varios heredocs en líneas distintas conservan cada asociación', async () => {
  const ir = await parseBash('cat <<X | bash\nuno\nX\ncat <<Y | sh\ndos\nY');
  assert.deepEqual(names(ir), ['cat', 'bash', 'cat', 'sh']);
  assert.equal(byName(ir, 'bash').stdin.text, 'uno\n');
  assert.equal(byName(ir, 'sh').stdin.text, 'dos\n');
});

test('IR: heredoc dentro de $( ) y heredoc directo sin pipe', async () => {
  assert.equal(byName(await parseBash('x=$(cat <<X | bash\nb\nX\n)'), 'bash').stdin.kind, 'literal');
  const d = byName(await parseBash("node <<'X'\nconsole.log(1)\nX"), 'node').stdin;
  assert.deepEqual(d, { kind: 'literal', text: 'console.log(1)\n', expands: false });
});

test('IR: estructura no interpretable -> heredocError', async () => {
  for (const c of ['cat <<X 2>/dev/null | bash\nb\nX', 'cat <<A <<B | bash\na\nA\nb\nB', 'cat <<X; bash\nb\nX']) {
    assert.equal((await parseBash(c)).heredocError, true, c);
  }
  assert.equal((await parseBash('echo hola')).heredocError, false);
});

// ---------- 3. decide() ----------
const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const CASES = [
  // bloqueos: el programa que llega por el pipe se analiza
  ["cat <<'X' | bash\ngit push -f\nX", 'deny', 'H-01'],
  ['cat <<X | bash\ngit push -f\nX', 'deny', 'H-01'],
  ['cat <<-X | sh -s\n\tgit reset --hard\n\tX', 'deny', 'H-02'],
  ['cat <<X | bash | tee f\ngit push -f\nX', 'deny', 'H-01'],
  ['cat <<X | (bash)\ngit push -f\nX', 'deny', 'H-01'],
  ['cat <<X | { true; bash; }\ngit push -f\nX', 'deny', 'H-01'],
  ['cat <<X |& bash\ngit push -f\nX', 'deny', 'H-01'],
  ['cat <<X | bash > out\ngit push -f\nX', 'deny', 'H-01'],
  ['cat <<X | bash && echo ok\ngit push -f\nX', 'deny', 'H-01'],
  ['a | cat <<X | bash\ngit push -f\nX', 'deny', 'H-01'],
  ['x=$(cat <<X | bash\ngit push -f\nX\n)', 'deny', 'H-01'],
  ['cat <<X | bash\necho uno\nX\ncat <<Y | sh\ngit push -f\nY', 'deny', 'H-01'],
  ["cat <<'X' | bash\nsudo ls\nX", 'deny', 'H-04'],
  ["cat <<'X' | bash\npython -m scripts.seed_plans\nX", 'deny', 'H-06'],
  ["cat <<'PY' | python3\nopen('.claude/settings.json','w').write('{}')\nPY", 'deny', 'H-12'],
  ["cat <<'JS' | node\nrequire('fs').writeFileSync('CLAUDE.md','x')\nJS", 'deny'],
  ["cat <<'X' | bash\ncat .env\nX", 'deny', 'SEC'],
  // conservador: stdin no literal, expansiones o estructura no interpretable
  ['cat <<X | grep a | bash\necho hola\nX', 'deny', 'H-13'],
  ['cat foo.txt <<X | bash\nb\nX', 'deny', 'H-13'],
  ['cat <<X | node\n$PAYLOAD\nX', 'deny', 'H-13'],
  ["cat <<X | node\nrequire('fs').writeFileSync('$F','x')\nX", 'deny', 'H-13'],
  ['cat <<X 2>/dev/null | bash\necho hola\nX', 'deny', 'H-13'],
  ['cat <<A <<B | bash\na\nA\nb\nB', 'deny', 'H-13'],
  ['cat <<X; bash\nb\nX', 'deny', 'H-13'],
  // permitidos: heredocs inocuos o que sólo imprimen texto
  ["cat <<'X' | bash\necho hola\nX", 'allow'],
  ["cat <<'X' | bash\ngit status\nX", 'allow'],
  ["cat <<'X' | node\nconsole.log('hola')\nX", 'allow'],
  ['cat <<X | node\nconsole.log("$HOME")\nX', 'allow'],
  ["cat <<'X'\ngit push -f\nX", 'allow'],
  ["cat <<'X' | grep push\ngit push -f\nX", 'allow'],
  ["cat <<'X' > notas.txt\ntexto que menciona bash y node\nX", 'allow'],
  ['cat <<X | tee out.txt\nhola $HOME\nX', 'allow'],
  ['bash <<X | grep a\necho hola\nX', 'allow'],
  ['cat <<X 2>/dev/null\nsolo texto\nX', 'allow'],
  ['cat <<X && bash\ngit push -f\nX', 'allow'], // && no es pipe: bash no recibe el heredoc
];
for (const [cmd, expected, rule] of CASES) {
  test(`heredoc-pipe ${JSON.stringify(cmd)} => ${expected}${rule ? ' ' + rule : ''}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, expected, `${cmd} -> ${r.decision} [${r.rule ?? ''}] ${r.msg ?? ''}`);
    if (rule) assert.equal(r.rule, rule, `${cmd} -> ${r.rule} (${r.msg})`);
  });
}

// ---------- 4. proceso real de guard.mjs ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
const GUARD_CASES = [
  ['cat <<X | bash\ngit push -f\nX', 2, 'H-01'],
  ["cat <<'PY' | python\nopen('CLAUDE.md','w').write('x')\nPY", 2, 'H-12'],
  ['cat <<X 2>/dev/null | bash\necho hola\nX', 2, 'H-13'],
  ["cat <<'X' | bash\necho hola\nX", 0],
  ["cat <<'X' | grep push\ngit push -f\nX", 0],
];
for (const [cmd, status, rule] of GUARD_CASES) {
  test(`heredoc-pipe guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
