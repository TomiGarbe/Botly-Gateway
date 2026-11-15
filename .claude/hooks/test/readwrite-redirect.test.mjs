// P0.3-A: redirecciones de lectura-escritura `<>` y `N<>`.
// tree-sitter-bash fragmenta el operador: `1<>f` -> '<' + ERROR('>'); en un bloque -> ERROR('<') + '>';
// `<>f` y `0<>f` -> ERROR('<') antes del nodo y el número como palabra del comando. Antes se
// clasificaba como lectura y la escritura sobre un control protegido no pasaba por H-12/H-10.
// Se valida la IR de parseBash, decide() y el proceso real de guard.mjs. Ningún comando se ejecuta.
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
const froot = root.split('\\').join('/');
const first = async (cmd, name) => (await parseBash(cmd)).commands.find((c) => c.words[0]?.text === name);
const rw = (c) => c.redirects.filter((r) => r.op === '<>');

// ---------- IR de parseBash ----------
test('IR: <> y N<> se reconocen como lectura-escritura con su descriptor', async () => {
  for (const [cmd, fd] of [
    ['echo x <>f.txt', null], ['echo x 0<>f.txt', '0'], ['echo x 1<>f.txt', '1'],
    ['echo x 2<>f.txt', '2'], ['echo x 9<>f.txt', '9'], ['echo x 9<> f.txt', '9'], ['echo x <> f.txt', null],
  ]) {
    const c = await first(cmd, 'echo');
    const rs = rw(c);
    assert.equal(rs.length, 1, cmd);
    assert.deepEqual([rs[0].fd, rs[0].target.text, rs[0].write], [fd, 'f.txt', true], cmd);
  }
});

test('IR: el descriptor de 0<> no queda como argumento del comando', async () => {
  assert.deepEqual((await first('echo x 0<>f.txt', 'echo')).words.map((w) => w.text), ['echo', 'x']);
  assert.deepEqual((await first('echo x 1<>f.txt', 'echo')).words.map((w) => w.text), ['echo', 'x']);
  // un número que es argumento real (con espacio) se conserva
  assert.deepEqual((await first('echo 0 <>f.txt', 'echo')).words.map((w) => w.text), ['echo', '0']);
});

test('IR: <> sin descriptor o con 0 es entrada estándar; con 1, 2 o 9 no', async () => {
  for (const cmd of ['bash <>a.sh', 'bash 0<>a.sh']) {
    const c = await first(cmd, 'bash');
    assert.deepEqual([c.stdin.kind, c.stdin.target.text], ['file', 'a.sh'], cmd);
  }
  for (const cmd of ['bash 1<>a.sh', 'bash 2<>a.sh', 'bash 9<>a.sh']) {
    assert.equal((await first(cmd, 'bash')).stdin.kind, 'none', cmd);
  }
});

test('IR: <> dentro de bloque, subshell, pipeline y heredoc', async () => {
  for (const [cmd, name] of [
    ['{ echo x 1<>f.txt; }', 'echo'], ['( echo x 1<>f.txt )', 'echo'],
    ['echo x 1<>f.txt | cat', 'echo'], ['cat a | tee 2<>f.txt', 'tee'],
    ["cat <<'X' 1<>f.txt\nx\nX", 'cat'], ["cat 1<>f.txt <<'X'\nx\nX", 'cat'],
  ]) {
    const rs = rw(await first(cmd, name));
    assert.deepEqual(rs.map((r) => [r.target.text, r.write]), [['f.txt', true]], cmd);
  }
});

test('IR: el ERROR que sólo contiene el operador no genera destinos alternativos', async () => {
  const c = await first('echo x 1<>f.txt', 'echo');
  assert.equal(c.redirects.length, 1);
  assert.equal(c.redirects.filter((r) => r.alternative).length, 0);
});

test('IR: ninguna redirección <> se procesa dos veces', async () => {
  for (const cmd of ['echo x 1<>f.txt', 'echo x <>f.txt', "cat <<'X' 1<>f.txt\nx\nX", '{ echo x 1<>f.txt; }']) {
    const p = await parseBash(cmd);
    const ids = p.commands.flatMap((c) => c.redirects.map((r) => r.id));
    assert.equal(new Set(ids).size, ids.length, cmd);
    assert.deepEqual(p.orphanRedirects, [], cmd);
  }
});

test('IR: las redirecciones simples conservan su clasificación', async () => {
  const cls = async (cmd) => (await first(cmd, 'cat')).redirects.map((r) => [r.op, r.write, r.fd]);
  assert.deepEqual(await cls('cat < f.txt'), [['<', false, null]]);
  // `0<`: tree-sitter deja el 0 como palabra (comportamiento previo, fuera de alcance); sigue siendo lectura.
  assert.deepEqual((await cls('cat 0< f.txt')).map(([op, w]) => [op, w]), [['<', false]]);
  assert.deepEqual(await cls('cat > f.txt'), [['>', true, null]]);
  assert.deepEqual(await cls('cat >> f.txt'), [['>>', true, null]]);
  assert.deepEqual(await cls('cat 2> f.txt'), [['>', true, '2']]);
  assert.deepEqual(await cls('cat <&3'), [['<&', false, null]]);
  assert.deepEqual(await cls('cat 2>&1'), [['>&', false, '2']]);
});

// ---------- decide() ----------
const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const TARGETS = [
  ['CLAUDE.md', 'H-12'],
  ['.claude/settings.json', 'H-12'],
  ['.claude/hooks/guard.mjs', 'H-12'],
  ['.git/config', 'H-12'],
  ['docs/MODULO_02_HANDOFF.md', 'H-10'],
];
const FDS = ['', '0', '1', '2', '9'];
for (const [t, rule] of TARGETS) {
  for (const fd of FDS) {
    for (const target of [t, `${froot}/${t}`]) {
      const cmd = `echo x ${fd}<>${target}`;
      test(`decide ${JSON.stringify(`echo x ${fd}<>${t}`)}${target === t ? '' : ' (absoluta)'} => deny con ${rule}`, async () => {
        const r = await run(cmd);
        assert.equal(r.decision, 'deny');
        assert.ok(r.all.some((x) => x.rule === rule), JSON.stringify(r.all));
      });
    }
  }
}

// Sin vocabulario sensible literal el error de parseo no dispara H-13: la decisión es la del destino.
const CASES = [
  ["echo x 1<>C''LAUDE.md", 'deny', 'H-12'],
  ["echo x 1<>'CLAUDE.md'", 'deny', 'H-12'],
  ['echo x 1<>"CLAUDE.md"', 'deny', 'H-12'],
  ['echo x 2<>docs/MODULO_02_HANDOFF.md', 'deny', 'H-10'],
  ['echo x 2<> docs/MODULO_02_HANDOFF.md', 'deny', 'H-10'],
  ['echo x <>docs/MODULO_02_HANDOFF.md', 'deny', 'H-10'],
  ['echo x 0<>docs/MODULO_02_HANDOFF.md', 'deny', 'H-10'],
  ['echo x 9<>./docs/../docs/MODULO_02_HANDOFF.md', 'deny', 'H-10'],
  ["echo x 1<>'<FROOT>/docs/MODULO_02_HANDOFF.md'", 'deny', 'H-10'],
  // expansiones: destino dinámico -> H-12
  ['echo x 1<>"$F"', 'deny', 'H-12'],
  ['echo x <>$F', 'deny', 'H-12'],
  ['echo x 2<>"$(echo f)"', 'deny', 'H-12'],
  // pipelines, bloques, subshells y heredoc
  ['echo x 2<>docs/MODULO_02_HANDOFF.md | cat', 'deny', 'H-10'],
  ['cat a.txt | tee 1<>docs/MODULO_02_HANDOFF.md', 'deny', 'H-10'],
  ['{ echo x 1<>docs/MODULO_02_HANDOFF.md; }', 'deny', 'H-10'],
  ['( echo x 1<>docs/MODULO_02_HANDOFF.md )', 'deny', 'H-10'],
  ["cat <<'X' 1<>docs/MODULO_02_HANDOFF.md\nx\nX", 'deny', 'H-10'],
  ["cat 2<>docs/MODULO_02_HANDOFF.md <<'X'\nx\nX", 'deny', 'H-10'],
  // destinos no protegidos
  ['echo x 1<>out.txt', 'allow'],
  ['echo x <>out.txt', 'allow'],
  ['echo x 0<>out.txt', 'allow'],
  ['echo x 9<> notas/a.md', 'allow'],
  ["echo x 1<>'<FROOT>/out.txt'", 'allow'],
  ['{ echo x 1<>out.txt; }', 'allow'],
  ["cat <<'X' 1<>out.txt\nx\nX", 'allow'],
  // lecturas que siguen siendo lecturas
  ['cat < CLAUDE.md', 'allow'],
  ['cat 0< .claude/settings.json', 'allow'],
  ['cat < docs/MODULO_02_HANDOFF.md', 'allow'],
  ['cat < .env', 'deny', 'SEC'],
  ['echo x 1<>.env', 'deny', 'SEC'],
  // escrituras simples: sin cambios
  ['echo x > docs/MODULO_02_HANDOFF.md', 'deny', 'H-10'],
  ['echo x >> CLAUDE.md', 'deny', 'H-12'],
  ['echo x 2>&1', 'allow'],
  // stdin <> hacia un intérprete: se analiza el archivo
  ['bash <>scripts/evil.sh', 'deny', 'H-01'],
  ['bash 0<>scripts/ok.sh', 'allow'],
];
for (const [c, decision, rule] of CASES) {
  const cmd = c.replaceAll('<FROOT>', froot);
  test(`decide ${JSON.stringify(c)} => ${decision}${rule ? ' ' + rule : ''}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, decision, JSON.stringify(r));
    if (rule) assert.ok(r.all.some((x) => x.rule === rule), JSON.stringify(r.all));
  });
}

// ---------- guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  ['echo x 2<>docs/MODULO_02_HANDOFF.md', 2, 'H-10'],
  ["echo x 1<>C''LAUDE.md", 2, 'H-12'],
  ['echo x 1<>out.txt', 0],
]) {
  test(`readwrite guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
