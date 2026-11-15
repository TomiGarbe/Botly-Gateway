// P0.3-B1: `<>` y `N<>` dentro de bloques `{ }` con heredoc.
// En `{ cat <<'X' 1<>f; }` tree-sitter-bash deja '<' + ERROR('>', word "f; ", '}') + word de la
// línea siguiente: el operador salía '<' (lectura) y el destino era texto del cuerpo. Con fd 0 no
// hay file_redirect: number('0') + ERROR(word "<>f; ") dentro del heredoc, o una concatenación con
// ERROR(word '<>'). Se valida el AST real, la IR de parseBash, decide() y el proceso de guard.mjs.
// Ningún comando se ejecuta.
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
const blk = (redir, body = 'contenido') => `{ cat <<'X' ${redir}; }\n${body}\nX`;

// ---------- AST real (tree-sitter vendorizado) ----------
const vendor = (p) => path.join(HOOKS, 'vendor', p);
const ts = await import(pathToFileURL(vendor('web-tree-sitter/web-tree-sitter.js')).href);
await ts.Parser.init({ locateFile: () => vendor('web-tree-sitter/web-tree-sitter.wasm') });
const parser = new ts.Parser();
parser.setLanguage(await ts.Language.load(vendor('tree-sitter-bash/tree-sitter-bash.wasm')));
const ast = (src, fn) => { const t = parser.parse(src); try { return fn(t.rootNode); } finally { t.delete(); } };
const tok = (n) => (n.isNamed ? n.type : JSON.stringify(n.type));

test('AST: N<> en bloque con heredoc -> "<" + ERROR(">", destino, "}") (operador y destino juntos)', () => {
  for (const fd of ['1', '2', '9', '10']) {
    ast(blk(`${fd}<>docs/M.md`), (r) => {
      const fr = r.descendantsOfType('file_redirect')[0];
      assert.deepEqual(fr.children.map(tok), ['file_descriptor', '"<"', 'ERROR', 'word'], fd);
      const err = fr.children[2];
      assert.deepEqual(err.children.map(tok), ['">"', 'word', '"}"'], fd);
      assert.equal(err.children[1].text, 'docs/M.md; ');
      assert.equal(fr.namedChildren[0].text, fd);
      assert.equal(fr.children[3].text, 'contenido'); // la "palabra destino" es la línea siguiente
    });
  }
});

test('AST: 0<> en bloque con heredoc -> number + ERROR(word "<>...") sin file_redirect', () => {
  ast(blk('0<>docs/M.md'), (r) => {
    assert.equal(r.descendantsOfType('file_redirect').length, 0);
    const h = r.descendantsOfType('heredoc_redirect')[0];
    const n = h.namedChildren.find((c) => c.type === 'number');
    assert.equal(n.text, '0');
    assert.equal(n.nextSibling.type, 'ERROR');
    assert.equal(n.nextSibling.children[0].text, '<>docs/M.md; ');
  });
  ast(blk('0<>$F'), (r) => {
    const w = r.descendantsOfType('word').find((x) => x.text === '<>');
    assert.ok(w && w.parent.type === 'ERROR' && w.parent.parent.type === 'concatenation');
  });
});

// ---------- IR de parseBash ----------
const cat = async (cmd) => (await parseBash(cmd)).commands.find((c) => c.words[0]?.text === 'cat');
const rw = (c) => c.redirects.filter((r) => r.op === '<>');

test('IR: <> y N<> en bloque con heredoc: escritura, descriptor y destino real', async () => {
  for (const [redir, fd, target] of [
    ['<>docs/M.md', null, 'docs/M.md'], ['0<>docs/M.md', '0', 'docs/M.md'], ['1<>docs/M.md', '1', 'docs/M.md'],
    ['2<>docs/M.md', '2', 'docs/M.md'], ['9<>docs/M.md', '9', 'docs/M.md'], ['10<>docs/M.md', '10', 'docs/M.md'],
    ['1<>./docs/../docs/M.md', '1', './docs/../docs/M.md'], ['1<>/abs/docs/M.md', '1', '/abs/docs/M.md'],
  ]) {
    const rs = rw(await cat(blk(redir)));
    assert.equal(rs.length, 1, redir);
    assert.deepEqual([rs[0].fd, rs[0].target.text, rs[0].write], [fd, target, true], redir);
  }
});

test('IR: el destino se corta antes de listas y pipelines; los argumentos no son destinos', async () => {
  for (const tail of [' | grep a', ' && echo ok', '; echo b']) {
    const c = await cat(blk(`1<>docs/M.md${tail}`));
    assert.deepEqual(c.redirects.filter((r) => r.write).map((r) => r.target.text), ['docs/M.md'], tail);
    assert.equal(c.redirects.filter((r) => r.alternative).length, 0, tail);
  }
});

test('IR: la línea del cuerpo del heredoc no se toma como destino', async () => {
  const c = await cat(blk('1<>out.txt', 'CLAUDE.md'));
  assert.deepEqual(c.redirects.filter((r) => r.write).map((r) => r.target.text), ['out.txt']);
});

test('IR: destino no literal -> dinámico (text null)', async () => {
  for (const redir of ['1<>$F', '1<>"$F"', '0<>$F', '1<>~/x', '1<>*.md']) {
    const p = await parseBash(blk(redir));
    const all = [...p.commands.flatMap((c) => c.redirects), ...p.orphanRedirects].filter((r) => r.op === '<>');
    assert.equal(all.length, 1, redir);
    assert.deepEqual([all[0].write, all[0].target.text], [true, null], redir);
  }
});

test('IR: ninguna redirección se procesa dos veces', async () => {
  for (const redir of ['1<>docs/M.md', '0<>docs/M.md', '<>docs/M.md', '1<>docs/M.md | grep a', '0<>$F']) {
    const p = await parseBash(blk(redir));
    const ids = [...p.commands.flatMap((c) => c.redirects.map((r) => r.id)), ...p.orphanRedirects.map((r) => r.id)];
    assert.equal(new Set(ids).size, ids.length, redir);
    assert.equal(ids.length, new Set(ids).size);
  }
});

// Redirecciones de comandos más las huérfanas (tree-sitter deja algunas fuera del comando).
const allRedirects = async (cmd) => {
  const p = await parseBash(cmd);
  return [...p.commands.flatMap((c) => c.redirects), ...p.orphanRedirects];
};

test('IR: subshell, bloque sin heredoc y comando simple: sin cambios respecto de P0.3-A', async () => {
  for (const cmd of ["( cat <<'X' 1<>f.txt )\nx\nX", '{ cat 1<>f.txt; }', "cat <<'X' 1<>f.txt\nx\nX", 'cat 1<>f.txt']) {
    const rs = (await allRedirects(cmd)).filter((r) => r.op === '<>');
    assert.deepEqual(rs.map((r) => [r.target.text, r.write]), [['f.txt', true]], cmd);
  }
});

test('IR: lecturas y salidas en bloque con heredoc conservan su clasificación', async () => {
  const cls = async (redir) => (await allRedirects(blk(redir))).filter((r) => r.op !== '<<').map((r) => [r.op, r.write]);
  assert.deepEqual(await cls('< in.txt'), [['<', false]]);
  // 2>&1 duplica un descriptor: sin archivo destino no queda ninguna escritura (huérfana sin target).
  assert.deepEqual((await cls('2>&1')).filter(([, w]) => w), []);
  assert.deepEqual(await cls('> out.txt'), [['>', true]]);
});

test('IR: argumentos con < o > entre comillas o escapados no generan redirecciones', async () => {
  for (const cmd of ["echo '<>x' \"<>y\" a\\<\\>b", "{ echo '<>x' \"<>y\" a\\<\\>b; }", "{ echo '<>' <<'X' a; }\nc\nX"]) {
    const p = await parseBash(cmd);
    assert.deepEqual(p.commands.flatMap((c) => c.redirects.filter((r) => r.write)), [], cmd);
    assert.deepEqual(p.orphanRedirects, [], cmd);
  }
});

test('IR: una línea "<>f" dentro del cuerpo del heredoc no es una redirección', async () => {
  for (const cmd of ["cat <<'X'\n<>docs/M.md\nX", "{ cat <<'X'\n<>docs/M.md\nX\n}"]) {
    const p = await parseBash(cmd);
    assert.deepEqual([...p.commands.flatMap((c) => c.redirects), ...p.orphanRedirects].filter((r) => r.op === '<>'), [], cmd);
  }
});

// ---------- decide() ----------
const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const TARGETS = [
  ['CLAUDE.md', 'H-12'],
  ['.claude/settings.json', 'H-12'],
  ['.git/config', 'H-12'],
  ['docs/MODULO_02_HANDOFF.md', 'H-10'],
];
for (const [t, rule] of TARGETS) {
  for (const fd of ['', '0', '1', '2', '9', '10']) {
    for (const target of [t, `${froot}/${t}`]) {
      test(`decide ${JSON.stringify(blk(`${fd}<>${t}`))}${target === t ? '' : ' (absoluta)'} => deny con ${rule}`, async () => {
        const r = await run(blk(`${fd}<>${target}`));
        assert.equal(r.decision, 'deny');
        assert.ok(r.all.some((x) => x.rule === rule), JSON.stringify(r.all));
      });
    }
  }
}

const CASES = [
  // el caso de la revisión
  [blk('1<>docs/MODULO_02_HANDOFF.md'), 'deny', 'H-10'],
  // ./ y ../
  [blk('1<>./docs/../docs/MODULO_02_HANDOFF.md'), 'deny', 'H-10'],
  [blk('2<>./docs/MODULO_02_HANDOFF.md'), 'deny', 'H-10'],
  [blk('9<>docs/../CLAUDE.md'), 'deny', 'H-12'],
  // comillas
  [blk("1<>'docs/MODULO_02_HANDOFF.md'"), 'deny', 'H-10'],
  [blk("0<>'docs/MODULO_02_HANDOFF.md'"), 'deny', 'H-10'],
  [blk("1<>C''LAUDE.md"), 'deny', 'H-12'],
  // destino no literal -> H-12
  [blk('1<>"$F"'), 'deny', 'H-12'],
  [blk('1<>$F'), 'deny', 'H-12'],
  [blk('0<>$F'), 'deny', 'H-12'],
  [blk('<>$F'), 'deny', 'H-12'],
  [blk('1<>~/x'), 'deny', 'H-12'],
  [blk('1<>*.md'), 'deny', 'H-12'],
  // listas y pipelines dentro del bloque
  [blk('1<>docs/MODULO_02_HANDOFF.md | grep a'), 'deny', 'H-10'],
  [blk('0<>docs/MODULO_02_HANDOFF.md | grep a'), 'deny', 'H-10'],
  [blk('1<>docs/MODULO_02_HANDOFF.md && echo ok'), 'deny', 'H-10'],
  [blk('1<>docs/MODULO_02_HANDOFF.md; echo b'), 'deny', 'H-10'],
  [`{ echo a; cat <<'X' 2<>docs/MODULO_02_HANDOFF.md; }\nc\nX`, 'deny', 'H-10'],
  // otras formas del mismo bloque (ya cubiertas antes; no deben cambiar)
  [blk('1<> docs/MODULO_02_HANDOFF.md'), 'deny', 'H-10'],
  [`{ cat 1<>docs/MODULO_02_HANDOFF.md <<'X'; }\nc\nX`, 'deny', 'H-10'],
  [`{ cat <<'X' 1<>docs/MODULO_02_HANDOFF.md\nc\nX\n}`, 'deny', 'H-10'],
  // subshells: comportamiento intacto
  [`( cat <<'X' 1<>docs/MODULO_02_HANDOFF.md )\nc\nX`, 'deny', 'H-10'],
  [`( cat <<'X' 1<>out.txt )\nc\nX`, 'allow'],
  // destinos no protegidos
  [blk('1<>out.txt'), 'allow'],
  [blk('0<>out.txt'), 'allow'],
  [blk('<>out.txt'), 'allow'],
  [blk('10<>notas/a.md'), 'allow'],
  [blk(`1<>${froot}/out.txt`), 'allow'],
  [blk('1<>out.txt | grep a'), 'allow'],
  [blk('0<>"a b"'), 'allow'],
  // argumentos con < o > que no son redirecciones
  ["{ echo '<>x' \"<>y\" a\\<\\>b; }", 'allow'],
  [`{ echo '<>' <<'X' a; }\nc\nX`, 'allow'],
  [`{ cat <<'X'\n<>docs/MODULO_02_HANDOFF.md\nX\n}`, 'allow'],
  // ERROR que no representa escritura
  [blk('2>&1'), 'allow'],
  [blk('< in.txt'), 'allow'],
];
for (const [cmd, decision, rule] of CASES) {
  test(`decide ${JSON.stringify(cmd.replaceAll(froot, '<FROOT>'))} => ${decision}${rule ? ' ' + rule : ''}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, decision, JSON.stringify(r));
    if (rule) assert.ok(r.all.some((x) => x.rule === rule), JSON.stringify(r.all));
  });
}

// ---------- guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  [blk('1<>docs/MODULO_02_HANDOFF.md'), 2, 'H-10'],
  [blk('0<>docs/MODULO_02_HANDOFF.md'), 2, 'H-10'],
  [blk('1<>out.txt'), 0],
]) {
  test(`block-heredoc guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
