// 2.2.3.4: precedencia de la redirección de entrada propia (`< archivo`) sobre el stdin del pipeline.
// En Bash, `cat <<X | bash < a.sh` ejecuta a.sh, no el heredoc. Antes el IR asignaba el heredoc y el
// archivo quedaba sin analizar (regresión A-1 de la revisión de 2.2.3.3).
// Se valida la IR de parseBash, decide() y el proceso real de guard.mjs. Ningún comando se ejecuta.
// Fixture: scripts/evil.sh contiene `git push --force origin main`; scripts/ok.sh contiene `echo hola`.
import './env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseBash } from '../lib/bash.mjs';
import { decide } from '../lib/decide.mjs';
import { makeFixture } from './fixture.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = makeFixture();
const byName = (ir, n) => ir.commands.find((c) => c.words[0]?.text === n);
const stdinOf = async (cmd, n) => byName(await parseBash(cmd), n).stdin;

// ---------- IR de parseBash ----------
test('IR: bash < archivo.sh -> stdin file con destino; no el heredoc', async () => {
  const st = await stdinOf("cat <<'X' | bash < archivo.sh\necho prueba\nX", 'bash');
  assert.equal(st.kind, 'file');
  assert.equal(st.target.text, 'archivo.sh');
  assert.equal(st.text, '');
});

test('IR: node < archivo.js y python < archivo.py -> stdin file', async () => {
  const n = await stdinOf("cat <<'X' | node < archivo.js\nconsole.log(1)\nX", 'node');
  assert.deepEqual([n.kind, n.target.text], ['file', 'archivo.js']);
  const p = await stdinOf("cat <<'X' | python < archivo.py\nprint(1)\nX", 'python');
  assert.deepEqual([p.kind, p.target.text], ['file', 'archivo.py']);
});

test('IR: redirecciones de salida no cambian el stdin del heredoc', async () => {
  for (const c of ["cat <<'X' | bash > out.txt\nb\nX", "cat <<'X' | bash >> out.txt\nb\nX", "cat <<'X' | bash 2> err.txt\nb\nX"]) {
    const st = await stdinOf(c, 'bash');
    assert.equal(st.kind, 'literal', c);
    assert.equal(st.text, 'b\n', c);
  }
});

test('IR: sin redirecciones adicionales sigue llegando el heredoc', async () => {
  assert.deepEqual(await stdinOf("cat <<'X' | bash\nb\nX", 'bash'), { kind: 'literal', text: 'b\n', expands: false, via: 'heredoc-pipe' });
});

test('IR: < y > en el mismo receptor, en cualquier orden -> file', async () => {
  for (const c of ["cat <<'X' | bash < a.sh > out\nb\nX", "cat <<'X' | bash > out < a.sh\nb\nX"]) {
    const st = await stdinOf(c, 'bash');
    assert.deepEqual([st.kind, st.target.text], ['file', 'a.sh'], c);
  }
});

test('IR: entradas múltiples o duplicación de descriptor -> dynamic', async () => {
  for (const c of ["cat <<'X' | bash < a.sh < b.sh\nb\nX", "cat <<'X' | bash <&3\nb\nX", "bash <<'Y' < a.sh\nb\nY"]) {
    assert.equal((await stdinOf(c, 'bash')).kind, 'dynamic', c);
  }
});

test('IR: `cat <<X < f | bash` no es estructurable: bash se recupera por lectura léxica (P0.3-B1.1) con stdin dinámico', async () => {
  const cmd = "cat <<'X' < f.txt | bash\nb\nX";
  const ir = await parseBash(cmd);
  const bash = byName(ir, 'bash');
  assert.equal(bash.lexical, true);
  assert.ok(ir.recovered.commands.includes(bash));
  assert.equal(bash.stdin.kind, 'dynamic');
  assert.equal(ir.heredocError, true);
  const r = await decide({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: root }, { root });
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'H-13');
});

test('IR: `bash <<Y < a.sh` (< anidado en el heredoc, sin ERROR) -> dynamic', async () => {
  const ir = await parseBash("bash <<'Y' < a.sh\nb\nY");
  assert.equal(ir.heredocError, false);
  assert.equal(byName(ir, 'bash').stdin.kind, 'dynamic');
});

test('IR: descriptor distinto de 0 no es stdin', async () => {
  const st = await stdinOf("cat <<'X' | bash 3< a.sh\nb\nX", 'bash');
  assert.equal(st.kind, 'literal');
  const st2 = await stdinOf("cat <<'X' | bash 3< a.sh < b.sh\nb\nX", 'bash');
  assert.deepEqual([st2.kind, st2.target.text], ['file', 'b.sh']);
});

test('IR: herestring propia prevalece sobre el heredoc del pipeline', async () => {
  assert.deepEqual(await stdinOf("cat <<'X' | bash <<< 'echo x'\nb\nX", 'bash'), { kind: 'literal', text: 'echo x' });
});

test('IR: pipeline de tres comandos: la redirección sólo afecta al receptor que la tiene', async () => {
  const ir = await parseBash("cat <<'X' | grep a | bash < a.sh\nb\nX");
  assert.equal(byName(ir, 'grep').stdin.kind, 'literal');
  assert.deepEqual([byName(ir, 'bash').stdin.kind, byName(ir, 'bash').stdin.target.text], ['file', 'a.sh']);
  const ir2 = await parseBash("cat <<'X' | sort < d.txt | bash\nb\nX");
  assert.deepEqual([byName(ir2, 'sort').stdin.kind, byName(ir2, 'sort').stdin.target.text], ['file', 'd.txt']);
  assert.equal(byName(ir2, 'bash').stdin.kind, 'dynamic');
});

test('IR: receptor en subshell y en bloque', async () => {
  const s = await stdinOf("cat <<'X' | (bash < a.sh)\nb\nX", 'bash');
  assert.deepEqual([s.kind, s.target.text], ['file', 'a.sh']);
  const b = await stdinOf("cat <<'X' | { bash < a.sh; }\nb\nX", 'bash');
  assert.deepEqual([b.kind, b.target.text], ['file', 'a.sh']);
});

test('IR: el dueño del heredoc con otra entrada (cat < f <<X, cat 3<<X) -> receptor dynamic', async () => {
  assert.equal((await stdinOf("cat < f.txt <<'X' | bash\nb\nX", 'bash')).kind, 'dynamic');
  assert.equal((await stdinOf("cat 3<<'X' | bash\nb\nX", 'bash')).kind, 'dynamic');
});

test('IR: echo con pipe y < propio -> file (antes quedaba el texto de echo)', async () => {
  const st = await stdinOf("echo 'git status' | bash < a.sh", 'bash');
  assert.deepEqual([st.kind, st.target.text], ['file', 'a.sh']);
});

// ---------- decide() ----------
const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const CASES = [
  // el archivo de entrada es lo que se analiza
  ["cat <<'X' | bash < scripts/evil.sh\necho prueba\nX", 'deny', 'H-01'],
  ["cat <<'X' | bash < scripts/ok.sh\ngit push -f\nX", 'allow'], // el heredoc no es el programa ejecutado
  ["cat <<'X' | bash < archivo.sh\necho prueba\nX", 'deny', 'H-13'], // archivo inexistente: no verificable
  ["cat <<'X' | sh -s < scripts/evil.sh\necho prueba\nX", 'deny', 'H-01'],
  // node/python: igual que `node < archivo.js` sin heredoc (sus scripts no se analizan; limitación previa)
  ["cat <<'X' | node < archivo.js\nrequire('fs').writeFileSync('CLAUDE.md','x')\nX", 'allow'],
  ["cat <<'X' | python < archivo.py\nopen('CLAUDE.md','w').write('x')\nX", 'allow'],
  // salida: sigue analizándose el heredoc
  ["cat <<'X' | bash > out.txt\ngit push -f\nX", 'deny', 'H-01'],
  ["cat <<'X' | bash 2> err.txt\ngit push -f\nX", 'deny', 'H-01'],
  ["cat <<'X' | bash > out.txt\necho hola\nX", 'allow'],
  // sin redirecciones adicionales
  ["cat <<'X' | bash\ngit push -f\nX", 'deny', 'H-01'],
  ["cat <<'X' | bash\necho hola\nX", 'allow'],
  // < y > combinados
  ["cat <<'X' | bash < scripts/evil.sh > out.txt\necho hola\nX", 'deny', 'H-01'],
  ["cat <<'X' | bash > out.txt < scripts/ok.sh\ngit push -f\nX", 'allow'],
  // múltiples o ambiguas: bloqueo conservador
  ["cat <<'X' | bash < scripts/ok.sh < scripts/evil.sh\necho hola\nX", 'deny', 'H-13'],
  ["cat <<'X' | bash <&3\necho hola\nX", 'deny', 'H-13'],
  ["cat <<'X' | bash <> scripts/ok.sh\necho hola\nX", 'deny', 'H-13'],
  ["cat < f.txt <<'X' | bash\necho hola\nX", 'deny', 'H-13'],
  ["cat 3<<'X' | bash\necho hola\nX", 'deny', 'H-13'],
  // redirección de entrada anidada por tree-sitter dentro del heredoc (`<<X < f`)
  ["bash <<'Y' < scripts/evil.sh\necho hola\nY", 'deny', 'H-13'],
  ["bash < scripts/evil.sh <<'Y'\necho hola\nY", 'deny', 'H-13'],
  ["cat <<'X' < f.txt | bash\necho hola\nX", 'deny', 'H-13'],
  // descriptor distinto de 0
  ["cat <<'X' | bash 3< scripts/ok.sh < scripts/evil.sh\necho hola\nX", 'deny', 'H-01'],
  ["cat <<'X' | bash 3< scripts/evil.sh\necho hola\nX", 'allow'], // bash lee el heredoc, no fd 3
  // herestring propia
  ["cat <<'X' | bash <<< 'git push -f'\necho hola\nX", 'deny', 'H-01'],
  // tres comandos
  ["cat <<'X' | grep a | bash < scripts/evil.sh\necho hola\nX", 'deny', 'H-01'],
  ["cat <<'X' | grep a | bash < scripts/ok.sh\necho hola\nX", 'allow'],
  // subshell y bloque
  ["cat <<'X' | (bash < scripts/evil.sh)\necho hola\nX", 'deny', 'H-01'],
  ["cat <<'X' | { bash < scripts/ok.sh; }\ngit push -f\nX", 'allow'],
  // pipe desde echo con < propio
  ["echo 'git status' | bash < scripts/evil.sh", 'deny', 'H-01'],
  // sin heredoc: comportamiento previo
  ['bash < scripts/evil.sh', 'deny', 'H-01'],
  ['bash < scripts/ok.sh', 'allow'],
  ["cat <<'X' | sort < data.txt\nb\nX", 'allow'],
];
for (const [cmd, expected, rule] of CASES) {
  test(`stdin-redirect ${JSON.stringify(cmd)} => ${expected}${rule ? ' ' + rule : ''}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, expected, `${cmd} -> ${r.decision} [${r.rule ?? ''}] ${r.msg ?? ''}`);
    if (rule) assert.equal(r.rule, rule, `${cmd} -> ${r.rule} (${r.msg})`);
  });
}

// ---------- proceso real de guard.mjs ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  ["cat <<'X' | bash < scripts/evil.sh\necho prueba\nX", 2, 'H-01'],
  ["cat <<'X' | bash < scripts/ok.sh < scripts/evil.sh\necho hola\nX", 2, 'H-13'],
  ["cat <<'X' | bash < scripts/ok.sh\ngit push -f\nX", 0],
]) {
  test(`stdin-redirect guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
