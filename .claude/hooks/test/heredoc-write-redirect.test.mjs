// 2.2.3.5: redirecciones de escritura que tree-sitter-bash anida dentro de un heredoc.
// `cat <<'X' > CLAUDE.md` deja el `file_redirect` como hijo del `heredoc_redirect`; antes sólo se
// revisaban las redirecciones de primer nivel y la escritura pasaba sin H-12/H-10.
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
// Ruta absoluta con barras normales: sin comillas, Bash tomaría las barras invertidas como escapes.
const froot = root.split('\\').join('/');
const hd = (head) => `${head}\ntexto\nX`;
const cmdOf = async (cmd) => (await parseBash(cmd)).commands.find((c) => c.words[0]?.text === 'cat');
const writes = (c) => c.redirects.filter((r) => r.write).map((r) => [r.op, r.target?.text ?? null]);

// ---------- IR de parseBash ----------
test('IR: la escritura anidada en el heredoc aparece en redirects, en cualquier orden', async () => {
  for (const [head, op] of [
    ["cat > CLAUDE.md <<'X'", '>'], ["cat <<'X' > CLAUDE.md", '>'], ["cat <<'X' >> CLAUDE.md", '>>'],
    ["cat <<'X' >| CLAUDE.md", '>|'], ["cat <<'X' &> CLAUDE.md", '&>'],
  ]) {
    assert.deepEqual(writes(await cmdOf(hd(head))), [[op, 'CLAUDE.md']], head);
  }
});

test('IR: 2> anidado es escritura con fd 2', async () => {
  const c = await cmdOf(hd("cat <<'X' 2> CLAUDE.md"));
  const r = c.redirects.find((x) => x.write);
  assert.deepEqual([r.op, r.fd, r.target.text, r.stdin], ['>', '2', 'CLAUDE.md', false]);
});

test('IR: < anidado no es escritura (pero queda como redirección revisable)', async () => {
  const c = await cmdOf(hd("cat <<'X' < CLAUDE.md"));
  assert.deepEqual(writes(c), []);
  const r = c.redirects.find((x) => x.op === '<');
  assert.deepEqual([r.write, r.target.text], [false, 'CLAUDE.md']);
});

test('IR: >&2 anidado no es escritura a archivo', async () => {
  assert.deepEqual(writes(await cmdOf(hd("cat <<'X' >&2"))), []);
});

test('IR: varias salidas anidadas aparecen todas', async () => {
  assert.deepEqual(writes(await cmdOf(hd("cat <<'X' > out.txt > CLAUDE.md"))), [['>', 'out.txt'], ['>', 'CLAUDE.md']]);
  assert.deepEqual(writes(await cmdOf(hd("cat <<'X' 2> CLAUDE.md > out.txt"))), [['>', 'CLAUDE.md'], ['>', 'out.txt']]);
});

test('IR: ninguna redirección se repite (mismo nodo una sola vez)', async () => {
  for (const head of ["cat <<'X' > CLAUDE.md", "cat > a <<'X' >> b", "cat <<'X' < in.txt > out.txt 2> err.txt"]) {
    const c = await cmdOf(hd(head));
    const ids = c.redirects.filter((r) => !r.alternative).map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, head);
    assert.equal(c.redirects.filter((r) => r.heredoc !== null).length, 1, head);
    assert.ok(c.redirects.every((r) => r.nested === undefined), head);
  }
});

test('IR: aplanar no duplica stdin (el heredoc sigue siendo la única entrada)', async () => {
  const c = await cmdOf(hd("cat <<'X' > CLAUDE.md"));
  assert.deepEqual([c.stdin.kind, c.stdin.text], ['literal', 'texto\n']);
});

test('IR: redirección ambigua (heredoc + pipe) expone cada palabra como destino posible', async () => {
  const c = await cmdOf(hd("cat <<'X' > CLAUDE.md | grep a"));
  assert.deepEqual(writes(c), [['>', 'CLAUDE.md'], ['>', 'grep'], ['>', 'a']]);
  assert.ok(c.redirects.filter((r) => r.alternative).every((r) => r.stdin === false));
});

test('IR: redirección sin comando dentro de un bloque con ERROR -> orphanRedirects', async () => {
  const p = await parseBash(hd("{ cat <<'X' > CLAUDE.md; }"));
  assert.deepEqual(p.orphanRedirects.map((r) => [r.op, r.target.text, r.write]), [['>', 'CLAUDE.md', true]]);
  const q = await parseBash(hd("cat <<'X' > CLAUDE.md"));
  assert.deepEqual(q.orphanRedirects, []);
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
const FORMS = [(t) => `cat > ${t} <<'X'`, (t) => `cat <<'X' > ${t}`, (t) => `cat <<'X' >> ${t}`];
for (const [t, rule] of TARGETS) {
  for (const form of FORMS) {
    for (const target of [t, `${froot}/${t}`]) {
      const cmd = hd(form(target));
      test(`decide ${JSON.stringify(form(t))}${target === t ? '' : ' (absoluta)'} => deny ${rule}`, async () => {
        const r = await run(cmd);
        assert.equal(r.decision, 'deny');
        assert.equal(r.rule, rule);
      });
    }
  }
}

const CASES = [
  // otras variantes de salida anidada
  ["cat <<'X' 2> CLAUDE.md", 'deny', 'H-12'],
  ["cat <<'X' 2> .claude/rules/governance.md", 'deny', 'H-12'],
  ["cat <<'X' &> CLAUDE.md", 'deny', 'H-12'],
  ["cat <<'X' >| .claude/settings.local.json", 'deny', 'H-12'],
  ["cat <<'X' > ./docs/../CLAUDE.md", 'deny', 'H-12'],
  ["cat <<'X' > '<FROOT>/.claude/hooks/lib/policy.mjs'", 'deny', 'H-12'],
  // varias salidas: basta una protegida
  ["cat <<'X' > out.txt > CLAUDE.md", 'deny', 'H-12'],
  ["cat <<'X' 2> CLAUDE.md > out.txt", 'deny', 'H-12'],
  ["cat <<'X' > out.txt 2> docs/MODULO_02_HANDOFF.md", 'deny', 'H-10'],
  // destino dinámico: se mantiene H-12
  ['cat <<"X" > "$F"', 'deny', 'H-12'],
  // pipelines y bloques
  ["cat <<'X' | tee a.txt > CLAUDE.md", 'deny', 'H-12'],
  ["(cat <<'X' > CLAUDE.md\ntexto\nX\n)", 'deny', 'H-12', true],
  ["{ cat <<'X' > CLAUDE.md\ntexto\nX\n}", 'deny', 'H-12', true],
  ["if true; then cat <<'X' > CLAUDE.md\ntexto\nX\nfi", 'deny', 'H-12', true],
  ["f() { cat <<'X' > .git/config\ntexto\nX\n}", 'deny', 'H-12', true],
  // destinos no protegidos: esta regla no bloquea
  ["cat <<'X' > out.txt", 'allow'],
  ["cat <<'X' >> notas/a.md", 'allow'],
  ["cat > out.txt <<'X'", 'allow'],
  ["cat <<'X' > '<FROOT>/out.txt'", 'allow'],
  ["cat <<'X' > out.txt 2> err.txt", 'allow'],
  ["cat <<'X' > out.txt 2>&1", 'allow'],
  ["cat <<'X' 2> /dev/null", 'allow'],
  ["cat <<'X' >&2", 'allow'],
  ["cat <<'X' > out.txt | grep a", 'allow'],
  ["{ cat <<'X' > out.txt; }", 'allow'],
  // < no es escritura: leer un control no se bloquea; leer un sensible sigue en SEC
  ["cat <<'X' < CLAUDE.md", 'allow'],
  ["cat <<'X' < .claude/settings.json", 'allow'],
  ["cat <<'X' < .env", 'deny', 'SEC'],
];
for (const [c, decision, rule, full] of CASES) {
  const cmd = (full ? c : hd(c)).replaceAll('<FROOT>', froot);
  test(`decide ${JSON.stringify(c)} => ${decision}${rule ? ' ' + rule : ''}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, decision, JSON.stringify(r));
    if (rule) assert.equal(r.rule, rule);
  });
}

// Estructuras que tree-sitter no arma bien: H-13 por el error de parseo y, además, H-12 por el destino.
for (const c of [
  "cat <<'X' > CLAUDE.md | grep a",
  "{ cat <<'X' > CLAUDE.md; }",
  "( cat <<'X' > CLAUDE.md )",
  "cat <<'X' > out.txt | tee CLAUDE.md",
]) {
  test(`decide ambiguo ${JSON.stringify(c)} => deny con H-12 entre los motivos`, async () => {
    const r = await run(hd(c));
    assert.equal(r.decision, 'deny');
    assert.ok(r.all.some((x) => x.rule === 'H-12'), JSON.stringify(r.all));
  });
}

// ---------- guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  [hd("cat <<'X' > CLAUDE.md"), 2, 'H-12'],
  [hd("cat <<'X' >> docs/MODULO_02_HANDOFF.md"), 2, 'H-10'],
  [hd("cat <<'X' > out.txt"), 0],
]) {
  test(`write-redirect guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
