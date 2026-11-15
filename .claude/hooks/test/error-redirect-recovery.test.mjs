// P0.3-B1.1: reconstrucción de redirecciones y del resto de la línea cuando tree-sitter-bash
// produce nodos ERROR. Antes: `0>f` quedaba como concatenation[number, ERROR('>'), word] sin
// redirección, y lo que seguía a un destino recuperado (`; cp a doc`, `| tee doc`, `>doc`) se
// perdía dentro de una palabra del ERROR. Ahora, con ERROR, una lectura léxica del texto completo
// agrega a la IR (marcado `lexical`) todo lo que el AST no representó, y lo ilegible queda en
// `recovered.ambiguous` y se bloquea (H-13). Se valida AST, IR, decide() y guard.mjs.
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
const body = (head) => `${head}\nc\nX`;

// ---------- AST real ----------
const vendor = (p) => path.join(HOOKS, 'vendor', p);
const ts = await import(pathToFileURL(vendor('web-tree-sitter/web-tree-sitter.js')).href);
await ts.Parser.init({ locateFile: () => vendor('web-tree-sitter/web-tree-sitter.wasm') });
const parser = new ts.Parser();
parser.setLanguage(await ts.Language.load(vendor('tree-sitter-bash/tree-sitter-bash.wasm')));
const ast = (src, fn) => { const t = parser.parse(src); try { return fn(t.rootNode); } finally { t.delete(); } };

test('AST: `cat <<X 0>f` no produce file_redirect (number + ERROR(">") + palabra)', () => {
  ast(body("cat <<'X' 0>CLAUD''E.md"), (r) => {
    assert.equal(r.descendantsOfType('file_redirect').length, 0);
    const cc = r.descendantsOfType('concatenation')[0];
    assert.deepEqual(cc.namedChildren.map((c) => c.type), ['number', 'ERROR', 'word', 'raw_string', 'word']);
    assert.equal(cc.namedChildren[1].text, '>');
  });
});

test('AST: el resto de la línea queda dentro de una palabra del ERROR', () => {
  ast(body("{ cat <<'X' 1<>out.txt; cp out.txt docs/M.md; }"), (r) => {
    const w = r.descendantsOfType('word').find((x) => x.text.startsWith('out.txt'));
    assert.equal(w.text, 'out.txt; cp out.txt docs/M.md; ');
    assert.ok(w.parent.type === 'ERROR');
    assert.equal(r.descendantsOfType('command').some((c) => c.text.startsWith('cp')), false);
  });
  ast("{ cat <<'X' 1<>out.txt >docs/M.md; }", (r) => {
    assert.ok(r.descendantsOfType('word').some((x) => x.text === 'out.txt >docs/M.md; '));
  });
});

// ---------- IR ----------
const ir = (cmd) => parseBash(cmd);
const allRedirects = (p) => [...p.commands.flatMap((c) => c.redirects), ...p.orphanRedirects];
// Las alternativas (`alternative`) son destinos posibles de 2.2.3.5/P0.3-B1, no reconstrucciones.
const writes = (p) => allRedirects(p).filter((r) => r.write && !r.alternative).map((r) => [r.op, r.fd ?? null, r.target.text]);
const lexWrites = (p) => [...p.recovered.commands.flatMap((c) => c.redirects), ...p.recovered.redirects].filter((r) => r.write).map((r) => r.target.text);

test('IR: 0> / 0>> / 0>| / N> reconstruidos como escritura con su descriptor', async () => {
  for (const [head, op, fd] of [
    ["cat <<'X' 0>docs/M.md", '>', '0'], ["cat <<'X' 0>>docs/M.md", '>>', '0'],
    ["{ cat <<'X' 0>docs/M.md; }", '>', '0'], ["{ cat <<'X' 0>>docs/M.md; }", '>>', '0'],
    ["{ cat <<'X' 9>docs/M.md; }", '>', '9'], ["{ cat <<'X' 10>|docs/M.md; }", '>|', '10'],
  ]) {
    const p = await ir(body(head));
    assert.ok(writes(p).some(([o, f, t]) => o === op && f === fd && t === 'docs/M.md'), `${head}: ${JSON.stringify(writes(p))}`);
  }
});

test('IR: comillas concatenadas se resuelven al nombre real', async () => {
  assert.ok(writes(await ir(body("cat <<'X' 0>CLAUD''E.md"))).some(([, , t]) => t === 'CLAUDE.md'));
  assert.ok(writes(await ir(body("cat <<'X' 0>.cl''aude/settings.json"))).some(([, , t]) => t === '.claude/settings.json'));
  assert.ok(writes(await ir(body('{ cat <<\'X\' 0>"do"cs/M.md; }'))).some(([, , t]) => t === 'docs/M.md'));
});

test('IR: el resto de la línea se reconstruye (comandos y redirecciones) y queda en recovered', async () => {
  const p = await ir(body("{ cat <<'X' 2<>out.txt; cp out.txt docs/M.md; }"));
  const cp = p.recovered.commands.find((c) => c.words[0].text === 'cp');
  assert.deepEqual(cp.words.map((w) => w.text), ['cp', 'out.txt', 'docs/M.md']);
  assert.equal(cp.lexical, true);
  const q = await ir(body("{ cat <<'X' 1<>out.txt | tee docs/M.md; }"));
  assert.deepEqual(q.recovered.commands.find((c) => c.words[0].text === 'tee').words.map((w) => w.text), ['tee', 'docs/M.md']);
  const r = await ir("{ cat <<'X' 1<>out.txt >docs/M.md; }");
  assert.ok(writes(r).some(([o, , t]) => o === '>' && t === 'docs/M.md'));
  const s = await ir(body("{ cat <<'X' 1<>out.txt 2<>docs/M.md; }"));
  assert.ok(writes(s).some(([o, f, t]) => o === '<>' && f === '2' && t === 'docs/M.md'));
});

test('IR: listas ;, &&, || y pipelines después del destino recuperado', async () => {
  for (const tail of ['; echo>docs/M.md', ' && echo x>docs/M.md', ' || echo x>>docs/M.md', ' | tee -a x >docs/M.md']) {
    const p = await ir(body(`{ cat <<'X' 1<>out.txt${tail}; }`));
    assert.ok(writes(p).some(([, , t]) => t === 'docs/M.md'), tail);
  }
});

test('IR: la lectura léxica no toma el cuerpo del heredoc ni los comentarios como código', async () => {
  // (tree-sitter sí asocia la línea '> docs/M.md' del cuerpo a cat: falso positivo previo, ver informe)
  const p = await ir("{ cat <<'X' 1<>out.txt; }\n> docs/M.md\ncp a docs/M.md\nX");
  assert.deepEqual(lexWrites(p).filter((t) => t !== 'out.txt'), []);
  assert.equal(p.recovered.commands.some((c) => c.words[0].text === 'cp'), false);
  const q = await ir(body("{ cat <<'X' 1<>out.txt; echo hi # > docs/M.md\n}"));
  assert.equal(writes(q).some(([, , t]) => t === 'docs/M.md'), false);
});

test('IR: lecturas siguen siendo lecturas', async () => {
  for (const tail of ['; cat < docs/M.md', '; cat 0< docs/M.md', '; cat <&3', '; cat <<< hola', '; wc -l docs/M.md']) {
    const p = await ir(body(`{ cat <<'X' 1<>out.txt${tail}; }`));
    assert.equal(writes(p).some(([, , t]) => t === 'docs/M.md'), false, tail);
  }
  const p = await ir(body("{ cat <<'X' 1<>out.txt; cat < docs/M.md; }"));
  const c = p.recovered.commands.find((x) => x.words[0].text === 'cat');
  assert.deepEqual(c.redirects.map((r) => [r.op, r.write, r.target.text]), [['<', false, 'docs/M.md']]);
  assert.deepEqual([c.stdin.kind, c.stdin.target.text], ['file', 'docs/M.md']);
});

test('IR: > y < dentro de comillas, [[ ]], (( )), $( ) y <( ) no son redirecciones', async () => {
  for (const tail of ['; echo "a > docs/M.md" \'b > docs/M.md\'', '; [[ a > docs/M.md ]]', '; (( 3 > 2 ))',
    '; echo $(echo 1 > /dev/null)', '; diff <(sort a) <(sort b)', '; echo a\\>docs/M.md']) {
    const p = await ir(body(`{ cat <<'X' 1<>out.txt${tail}; }`));
    // out.txt es la escritura real; '> /dev/null' dentro de $( ) es una redirección real del subcomando.
    const ok = (t) => t === 'out.txt' || t === '/dev/null';
    assert.deepEqual(writes(p).filter(([, , t]) => !ok(t)), [], tail);
    assert.deepEqual(lexWrites(p).filter((t) => !ok(t)), [], tail);
  }
});

test('IR: destino no literal (expansión, comodín, ~) -> dinámico', async () => {
  for (const t of ['"$F"', '$F', 'docs/M*', '~/x', '$(echo f)']) {
    const p = await ir(body(`{ cat <<'X' 1<>out.txt; echo x > ${t}; }`));
    assert.ok(writes(p).some(([, , tx]) => tx === null), t);
  }
});

test('IR: contenido ilegible queda en recovered.ambiguous', async () => {
  for (const tail of ['; echo "sin cerrar', "; echo 'sin cerrar", '; echo >', '; echo $(sin cerrar']) {
    const p = await ir(body(`{ cat <<'X' 1<>out.txt${tail}; }`));
    assert.ok(p.recovered.ambiguous.length >= 1, tail);
    assert.ok(p.commands.some((c) => c.ambiguous && c.words[0].text === null), tail);
  }
});

test('IR: sin nodos ERROR no hay lectura léxica (comportamiento previo intacto)', async () => {
  for (const cmd of ['echo x > out.txt', "cat <<'X' > out.txt\nc\nX", 'echo x 1<>f.txt | cat', "( cat <<'X' )\nc\nX"]) {
    const p = await ir(cmd);
    if (!p.hasError) assert.deepEqual(p.recovered, { commands: [], redirects: [], ambiguous: [] }, cmd);
  }
});

test('IR: lo que el AST ya representa no se duplica', async () => {
  const p = await ir(body("{ cat <<'X' 1<>docs/M.md; }"));
  const keys = [...p.commands.flatMap((c) => c.redirects), ...p.orphanRedirects].filter((r) => r.write).map((r) => r.target.text);
  assert.deepEqual(keys, ['docs/M.md']);
  assert.equal(p.recovered.commands.some((c) => c.words[0].text === 'cat'), false);
});

// ---------- decide() ----------
const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const expectDeny = (cmd, rules) => async () => {
  const r = await run(cmd);
  assert.equal(r.decision, 'deny', JSON.stringify(r));
  assert.ok(r.all.some((x) => rules.includes(x.rule)), `${rules}: ${JSON.stringify(r.all)}`);
};

// Regresiones exactas de la revisión (A y B), sin cuerpo y con cuerpo.
const A = [
  ["cat <<'X' 0>CLAUD''E.md", 'H-12'],
  ["cat <<'X' 0>.cl''aude/settings.json", 'H-12'],
  [`cat <<'X' 0>${DOC}`, 'H-10'],
  [`{ cat <<'X' 0>${DOC}; }`, 'H-10'],
  [`{ cat <<'X' 0>${DOC}; } | cat`, 'H-10'],
  [`tee /dev/stdin <<'X' 0>${DOC}`, 'H-10'],
];
const B = [
  `{ cat <<'X' 1<>out.txt >${DOC}; }`,
  `{ cat <<'X' 1<>out.txt; echo>${DOC}; }`,
  `{ cat <<'X' 1<>out.txt | tee ${DOC}; }`,
  `{ cat <<'X' 1<>out.txt && echo x>${DOC}; }`,
  `{ cat <<'X' 1<>out.txt 2<>${DOC}; }`,
  `{ cat <<'X' 0<>out.txt 1<>${DOC}; }`,
  `{ cat <<'X' 2<>out.txt; cp out.txt ${DOC}; }`,
];
for (const [c, rule] of A) {
  test(`A ${JSON.stringify(c)} => deny ${rule}`, expectDeny(c, [rule]));
  test(`A ${JSON.stringify(body(c))} => deny ${rule}`, expectDeny(body(c), [rule]));
}
for (const c of B) {
  test(`B ${JSON.stringify(c)} => deny H-10`, expectDeny(c, ['H-10']));
  test(`B ${JSON.stringify(body(c))} => deny H-10`, expectDeny(body(c), ['H-10']));
}

// Matriz: operador × descriptor × destino protegido × ruta relativa/absoluta, dentro y fuera de bloque.
const TARGETS = [['CLAUDE.md', 'H-12'], ['.claude/settings.json', 'H-12'], ['.git/config', 'H-12'], [DOC, 'H-10']];
const FORMS = [
  (r) => `cat <<'X' ${r}`, (r) => `{ cat <<'X' ${r}; }`, (r) => `{ cat <<'X' 1<>out.txt; echo x ${r}; }`,
];
for (const [t, rule] of TARGETS) {
  for (const op of ['0>', '0>>', '0>|', '2>', '9>>', '10>', '<>', '0<>', '1<>']) {
    for (const [fi, form] of FORMS.entries()) {
      for (const target of [t, `${froot}/${t}`]) {
        const cmd = body(form(`${op}${target}`));
        test(`matriz forma${fi} ${op}${t}${target === t ? '' : ' (absoluta)'} => deny ${rule}`, expectDeny(cmd, [rule, 'H-13']));
      }
    }
  }
}
// Sin vocabulario sensible el error de parseo no aporta H-13: debe aparecer el motivo del destino.
for (const op of ['0>', '0>>', '0>|', '2>', '10>', '<>', '0<>', '>&', '&>', '&>>']) {
  for (const form of FORMS) {
    test(`destino H-10 ${JSON.stringify(form(`${op}${DOC}`))} => H-10`, expectDeny(body(form(`${op}${DOC}`)), ['H-10']));
  }
}

const CASES = [
  // comillas concatenadas y rutas con ./ ../
  [body(`{ cat <<'X' 0>do''cs/MODULO_02_HANDOFF.md; }`), 'deny', ['H-10']],
  [body(`{ cat <<'X' 0>"docs"/MODULO_02_HANDOFF.md; }`), 'deny', ['H-10']],
  [body(`{ cat <<'X' 0>./docs/../${DOC}; }`), 'deny', ['H-10']],
  [body(`{ cat <<'X' 1<>out.txt; echo x >| C''LAUDE.md; }`), 'deny', ['H-12']],
  [body(`{ cat <<'X' 1<>out.txt; echo x >'${froot}/${DOC}'; }`), 'deny', ['H-10']],
  // varias redirecciones en la misma construcción
  [body(`{ cat <<'X' 1<>out.txt >a.txt 2>${DOC}; }`), 'deny', ['H-10']],
  [body(`{ cat <<'X' 0>a.txt 1>b.txt 2>>${DOC}; }`), 'deny', ['H-10']],
  // comandos adicionales que escriben
  [body(`{ cat <<'X' 1<>out.txt; cp a.txt ${DOC}; }`), 'deny', ['H-10']],
  [body(`{ cat <<'X' 1<>out.txt; mv a.txt ${DOC}; }`), 'deny', ['H-10']],
  [body(`{ cat <<'X' 1<>out.txt | tee -a ${DOC}; }`), 'deny', ['H-10']],
  [body(`{ cat <<'X' 1<>out.txt || echo x>>${DOC}; }`), 'deny', ['H-10']],
  [body(`{ cat <<'X' 1<>out.txt; echo x 2>&1 >& ${DOC}; }`), 'deny', ['H-10']],
  // heredoc y herestring
  [body(`{ cat <<'X' 1<>out.txt; cat <<< hola > ${DOC}; }`), 'deny', ['H-10']],
  [`{ cat <<'X' 1<>out.txt; cat <<'Y' >${DOC}; }\nc\nX\nd\nY`, 'deny', ['H-10']],
  [`cat <<'X' 0>${DOC} <<'Y'\nc\nX\nd\nY`, 'deny', ['H-10']],
  // dinámicos y ambiguos: bloqueo conservador
  [body(`{ cat <<'X' 1<>out.txt; echo x > "$F"; }`), 'deny', ['H-12']],
  [body(`{ cat <<'X' 1<>out.txt; echo x > docs/MODULO_0*; }`), 'deny', ['H-12']],
  [body(`{ cat <<'X' 0>$F; }`), 'deny', ['H-12']],
  [body(`{ cat <<'X' 1<>out.txt; echo "sin cerrar > ${DOC}; }`), 'deny', ['H-13']],
  [body(`{ cat <<'X' 1<>out.txt; echo >; }`), 'deny', ['H-13']],
  [body(`{ cat <<'X' 1<>out.txt; echo $(sin cerrar; }`), 'deny', ['H-13']],
  // sensibles
  [body(`{ cat <<'X' 1<>out.txt; cat < .env; }`), 'deny', ['SEC']],
  [body(`{ cat <<'X' 0>.env; }`), 'deny', ['SEC']],
  // legítimos: no deben bloquearse
  [body("{ cat <<'X' 1<>out.txt; echo hola; }"), 'allow'],
  [body("{ cat <<'X' 0>out.txt; }"), 'allow'],
  [body("{ cat <<'X' 0>>notas/a.md; }"), 'allow'],
  [body("{ cat <<'X' 1<>out.txt | grep -c a; }"), 'allow'],
  [body("{ cat <<'X' 0<>out.txt; ls -la; }"), 'allow'],
  [body("{ cat <<'X' 2>/dev/null; }"), 'allow'],
  [body("{ cat <<'X' 1<>out.txt; echo x 2>&1; }"), 'allow'],
  [body(`{ cat <<'X' 1<>out.txt; cat < ${DOC}; }`), 'allow'],
  [body(`{ cat <<'X' 1<>out.txt; wc -l ${DOC}; }`), 'allow'],
  [body("{ cat <<'X' 1<>out.txt; cat <<< hola; }"), 'allow'],
  [body("{ cat <<'X' 1<>out.txt; [[ a > b ]] && echo y; }"), 'allow'],
  [body("{ cat <<'X' 1<>out.txt; (( 3 > 2 )) && echo y; }"), 'allow'],
  [body(`{ cat <<'X' 1<>out.txt; echo "a > ${DOC}" 'b > ${DOC}'; }`), 'allow'],
  [body("{ cat <<'X' 1<>out.txt; echo $(echo 1 > /dev/null); }"), 'allow'],
  [body("{ cat <<'X' 1<>out.txt; diff <(sort a) <(sort b); }"), 'allow'],
  [body("{ cat <<'X' 1<>out.txt; f() { echo a; }; }"), 'allow'],
  [`{ cat <<'X' 1<>out.txt; }\ncp a ${DOC}\nX`, 'allow'],
];
for (const [cmd, decision, rules] of CASES) {
  test(`decide ${JSON.stringify(cmd.replaceAll(froot, '<FROOT>'))} => ${decision}${rules ? ' ' + rules : ''}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, decision, JSON.stringify(r));
    if (rules) assert.ok(r.all.some((x) => rules.includes(x.rule)), JSON.stringify(r.all));
  });
}

// ---------- guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  [body(`{ cat <<'X' 0>${DOC}; }`), 2, 'H-10'],
  [body(`{ cat <<'X' 2<>out.txt; cp out.txt ${DOC}; }`), 2, 'H-10'],
  [body("cat <<'X' 0>CLAUD''E.md"), 2, 'H-12'],
  [body("{ cat <<'X' 1<>out.txt; echo hola; }"), 0],
]) {
  test(`recovery guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
