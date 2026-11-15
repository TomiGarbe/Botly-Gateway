// P0.3-B1.2: comodines con comillas concatenadas y contenido ejecutable de las sustituciones.
// Antes: (1) un destino de escritura con comodín se comparaba literal (`> C''LAUDE.m?` no
// coincidía con CLAUDE.md) y la lectura léxica descartaba el comodín si la palabra tenía alguna
// comilla; (2) la lectura léxica saltaba `…`, $(…), <(…) y >(…) como texto opaco, así que en
// árboles con ERROR los comandos internos no se analizaban. Ahora el comodín se detecta por
// segmento sin comillas y vuelve dinámico el destino de escritura (H-12), y el cuerpo de cada
// sustitución se relee recursivamente (o queda ambiguo -> H-13).
// Las pruebas exigen la regla específica con su motivo (H-10/H-12 sobre el archivo protegido) o
// un H-13 estructural, más evidencia en la IR: un H-13 por vocabulario sensible no alcanza.
// Ningún comando se ejecuta: sólo se analizan sus textos.
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
const DOC = 'docs/MODULO_02_HANDOFF.md';
const body = (head) => `${head}\nc\nX`;
/** Comillas invertidas con el escape de Bash para anidar: \ ` y $ llevan barra. */
const bt = (s) => '`' + s.replace(/[\\`$]/g, (c) => '\\' + c) + '`';

const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const allRedirects = (p) => [...p.commands.flatMap((c) => c.redirects), ...p.orphanRedirects];
// Las alternativas (`alternative`) son destinos posibles de 2.2.3.5/P0.3-B1, no reconstrucciones.
const writeTargets = (p) => allRedirects(p).filter((r) => r.write && r.target && !r.alternative).map((r) => r.target);
const named = (p, name) => p.commands.filter((c) => c.words[0]?.text === name);
// H-13 que no proviene del vocabulario sensible ni del vocabulario de intérpretes con heredoc.
const VOCAB_MSG = /toca algo sensible|junto a un intérprete|vocabulario sensible/;
const structuralH13 = (r) => r.all.some((x) => x.rule === 'H-13' && !VOCAB_MSG.test(x.msg));
// Regla específica sobre el archivo protegido (no un H-12 genérico por destino dinámico).
const PROTECTED = { 'H-12': /control protegido/, 'H-10': /skip-worktree/ };
const hits = (r, rule) => r.all.some((x) => x.rule === rule && PROTECTED[rule].test(x.msg));
const show = (cmd) => JSON.stringify(cmd.replaceAll(froot, '<FROOT>'));

// ---------- 1. Casos exactos de la auditoría ----------
const AUDIT_GLOB = [
  "{ cat <<'X' 0>C''LAUDE.m?; }",
  "{ cat <<'X' 0>.cl''aude/settings.jso?; }",
  "{ cat <<'X' 0>.g''it/confi?; }",
  "{ cat <<'X' 0>C''LAUDE.m*; }",
  `{ cat <<'X' 0>"docs"/MODULO_02_HANDOF?.md; }`,
];
for (const c of AUDIT_GLOB) {
  for (const cmd of [c, body(c)]) {
    test(`auditoría comodín ${show(cmd)} => deny H-12 por destino dinámico`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'deny', JSON.stringify(r));
      assert.ok(r.all.some((x) => x.rule === 'H-12' && /destino dinámico/.test(x.msg)), JSON.stringify(r.all));
      const p = await parseBash(cmd);
      const ws = writeTargets(p);
      assert.ok(ws.length > 0);
      assert.ok(ws.every((t) => t.text === null), JSON.stringify(ws));
      // La lectura léxica conserva el descriptor 0 y marca el comodín.
      assert.ok(allRedirects(p).some((r) => r.lexical && r.write && r.fd === '0' && r.target.glob && r.target.text === null));
    });
  }
}

const AUDIT_SUBST = [
  [`{ cat <<'X' 1<>out.txt; echo \`cp out.txt ${DOC}\`; }`, '``', 'cp'],
  [`{ cat <<'X' 1<>out.txt; echo \`echo x > ${DOC}\`; }`, '``', 'echo'],
  [`{ cat <<'X' 1<>out.txt; diff <(cp out.txt ${DOC}) out.txt; }`, '<()', 'cp'],
  [`{ cat <<'X' 1<>out.txt; tee >(cp out.txt ${DOC}); }`, '>()', 'cp'],
];
for (const [c, kind, name] of AUDIT_SUBST) {
  for (const cmd of [c, body(c)]) {
    test(`auditoría sustitución ${kind} ${show(cmd)} => deny H-10 sobre el comando interno`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'deny', JSON.stringify(r));
      assert.ok(hits(r, 'H-10'), JSON.stringify(r.all));
      const p = await parseBash(cmd);
      const inner = p.recovered.commands.find((x) => x.subst === kind && x.words[0]?.text === name);
      assert.ok(inner, JSON.stringify(p.recovered.commands.map((x) => [x.subst, x.words.map((w) => w.raw)])));
      assert.equal(inner.lexical, true);
      if (name === 'cp') assert.equal(inner.words[2].text, DOC);
      else assert.ok(inner.redirects.some((x) => x.write && x.target.text === DOC));
    });
  }
}

// ---------- 2. Comodines: comillas × comodín × destino × ruta × contexto ----------
const TARGETS = ['CLAUDE.md', '.claude/settings.json', '.git/config', DOC];
const QUOTES = [
  ['sin comillas', (t) => t],
  ["'' concatenadas", (t) => `${t[0]}''${t.slice(1)}`],
  ["prefijo '…'", (t) => `'${t.slice(0, 3)}'${t.slice(3)}`],
  ['prefijo "…"', (t) => `"${t.slice(0, 3)}"${t.slice(3)}`],
  ['"" concatenadas', (t) => `${t[0]}""${t.slice(1)}`],
  ['escape \\', (t) => `${t[0]}\\${t.slice(1)}`],
];
const GLOBS = [
  ['?', (w) => `${w.slice(0, -1)}?`],
  ['*', (w) => `${w.slice(0, -2)}*`],
  ['[…]', (w) => `${w.slice(0, -1)}[${w.at(-1)}]`],
];
const GLOB_CONTEXTS = [
  ['bloque con heredoc 0>', (w) => `{ cat <<'X' 0>${w}; }`],
  ['heredoc con cuerpo 0>', (w) => body(`cat <<'X' 0>${w}`)],
  ['árbol sin ERROR >', (w) => `echo x > ${w}`],
  ['>> tras destino recuperado', (w) => `{ cat <<'X' 1<>out.txt; echo x >> ${w}; }`],
  ['<> en bloque', (w) => `{ cat <<'X' 2<>${w}; }`],
];
for (const t of TARGETS) {
  for (const abs of [false, true]) {
    for (const [cn, ctx] of GLOB_CONTEXTS) {
      test(`comodín ${abs ? 'absoluto' : 'relativo'} ${t} en ${cn}: toda combinación de comillas => H-12`, async () => {
        for (const [qn, q] of QUOTES) {
          for (const [gn, g] of GLOBS) {
            const word = g(q(t));
            const cmd = ctx(abs ? `${froot}/${word}` : word);
            const why = `${qn} ${gn}: ${show(cmd)}`;
            const r = await run(cmd);
            assert.equal(r.decision, 'deny', why);
            assert.ok(r.all.some((x) => x.rule === 'H-12' && /destino dinámico/.test(x.msg)), `${why} ${JSON.stringify(r.all)}`);
            const ws = writeTargets(await parseBash(cmd)).filter((x) => x.raw !== 'out.txt');
            assert.ok(ws.length > 0, why);
            assert.ok(ws.every((x) => x.text === null), `${why} ${JSON.stringify(ws)}`);
          }
        }
      });
    }
  }
}

// Comodín entre comillas o escapado: es literal (no expande) y no es una ruta protegida.
for (const cmd of [
  'echo x > "CLAUDE.m?"', "echo x > 'CLAUDE.m*'", 'echo x > CLAUDE.m\\?', 'echo x > "CLAUDE.m[d]"',
  'echo x > ".claude/settings.jso?"', 'echo x > out\\*.txt', `{ cat <<'X' 0>"out.tx?"; }`, `{ cat <<'X' 0>'out*.txt'; }`,
]) {
  test(`comodín literal ${show(cmd)} => allow, destino literal`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'allow', JSON.stringify(r));
    const ws = writeTargets(await parseBash(cmd));
    assert.ok(ws.length > 0 && ws.every((x) => x.text !== null && /[?*[]/.test(x.text) && !x.glob), JSON.stringify(ws));
  });
}

// Destinos dinámicos no protegidos: bloqueo conservador (falso positivo documentado).
for (const cmd of [
  'echo x > out*.txt', `{ cat <<'X' 0>o''ut?.txt; }`, 'echo x > log-[0-9].txt', 'echo x >> "logs"/*.txt',
  'echo x > out\\\\*.txt', // `\\` es una barra literal; el `*` sí expande
]) {
  test(`comodín no protegido ${show(cmd)} => deny H-12 (destino no verificable)`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(r.all.some((x) => x.rule === 'H-12' && /destino dinámico/.test(x.msg)), JSON.stringify(r.all));
  });
}

// Lecturas con comodín siguen siendo lecturas.
test('lecturas con comodín no se clasifican como escritura', async () => {
  for (const cmd of ['cat < CLAUDE.m?', `{ cat <<'X' 0<o''ut*.txt; }`, "cat < C''LAUDE.m*"]) {
    const r = await run(cmd);
    assert.equal(r.decision, 'allow', `${cmd} ${JSON.stringify(r)}`);
    const p = await parseBash(cmd);
    assert.equal(writeTargets(p).length, 0, cmd);
    assert.ok(allRedirects(p).some((x) => !x.write && x.target?.glob && x.target.text !== null), cmd);
  }
  const r = await run('cat < .en?');
  assert.equal(r.decision, 'deny');
  assert.ok(r.all.some((x) => x.rule === 'SEC'));
});

// ---------- 3. Sustituciones: forma × destino × ruta × contexto ----------
const RULE = (t) => (t === DOC ? 'H-10' : 'H-12');
const SUBST_FORMS = [
  ['`…`', (t) => `echo ${bt(`cp out.txt ${t}`)}`, 'cp'],
  ['$(…)', (t) => `echo $(cp out.txt ${t})`, 'cp'],
  ['"$(…)"', (t) => `echo "$(cp out.txt ${t})"`, 'cp'],
  ['"`…`"', (t) => `echo "${bt(`cp out.txt ${t}`)}"`, 'cp'],
  ['<(…)', (t) => `diff <(cp out.txt ${t}) out.txt`, 'cp'],
  ['>(…)', (t) => `tee >(cp out.txt ${t})`, 'cp'],
  ['asignación x=$(…)', (t) => `x=$(cp out.txt ${t})`, 'cp'],
  ['$(( $(…) ))', (t) => `echo $(( $(cp out.txt ${t}) + 1 ))`, 'cp'],
  ['$( (subshell) )', (t) => `echo $( (cp out.txt ${t}) )`, 'cp'],
  ['${x:-$(…)}', (t) => `echo \${x:-$(cp out.txt ${t})}`, 'cp'],
  ['< <(…)', (t) => `cat < <(cp out.txt ${t})`, 'cp'],
  ['destino > $(…)', (t) => `echo x > $(cp out.txt ${t})`, 'cp'],
  ['destino > `…`', (t) => `echo x > ${bt(`cp out.txt ${t}`)}`, 'cp'],
  ['<<< $(…)', (t) => `cat <<< $(cp out.txt ${t})`, 'cp'],
  ['[[ $(…) ]]', (t) => `[[ -n $(cp out.txt ${t}) ]]`, 'cp'],
  ['for … in $(…)', (t) => `for f in $(cp out.txt ${t}); do :; done`, 'cp'],
  // Sin ERROR, tree-sitter no representa `\`…\`` anidadas y no hay lectura léxica: limitación
  // pendiente fuera del alcance de esta etapa (cobertura de árboles sin ERROR); se prueban con ERROR.
  ['`…` anidadas x2', (t) => `echo ${bt(`echo ${bt(`cp out.txt ${t}`)}`)}`, 'cp', 'sóloERROR'],
  ['`…` anidadas x3', (t) => `echo ${bt(`echo ${bt(`echo ${bt(`cp out.txt ${t}`)}`)}`)}`, 'cp', 'sóloERROR'],
  ['$(…) anidadas x3', (t) => `echo $(echo $(echo $(cp out.txt ${t})))`, 'cp'],
  ['$( `…` )', (t) => `echo $(echo ${bt(`cp out.txt ${t}`)})`, 'cp'],
  ['`$(…)`', (t) => `echo ${bt(`echo $(cp out.txt ${t})`)}`, 'cp'],
  ['$(… > t)', (t) => `echo $(echo x > ${t})`, 'w'],
  ['`… >> t`', (t) => `echo ${bt(`echo x >> ${t}`)}`, 'w'],
  ['>(… > t)', (t) => `tee >(cat > ${t})`, 'w'],
  ['<(… >| t)', (t) => `diff <(echo x >| ${t}) out.txt`, 'w'],
];
const SUBST_CONTEXTS = [
  ['bloque con heredoc', (s) => `{ cat <<'X' 1<>out.txt; ${s}; }`],
  ['bloque con heredoc y cuerpo', (s) => body(`{ cat <<'X' 1<>out.txt; ${s}; }`)],
  ['bloque 2<>', (s) => `{ cat <<'X' 2<>out.txt; ${s}; }`],
  ['árbol sin ERROR', (s) => s],
];
const reaches = (p, t, kind) => (kind === 'cp'
  ? p.commands.some((c) => c.words[0]?.text === 'cp' && c.words.some((w) => w.text === t))
  : allRedirects(p).some((r) => r.write && r.target?.text === t));
for (const [fn, form, kind, only] of SUBST_FORMS) {
  for (const [cn, ctx] of SUBST_CONTEXTS) {
    if (only && cn === 'árbol sin ERROR') continue;
    test(`sustitución ${fn} en ${cn}: el comando interno se analiza (H-10/H-12)`, async () => {
      for (const t of TARGETS) {
        for (const abs of [false, true]) {
          const target = abs ? `${froot}/${t}` : t;
          const cmd = ctx(form(target));
          const rule = RULE(t);
          const r = await run(cmd);
          assert.equal(r.decision, 'deny', show(cmd));
          assert.ok(hits(r, rule), `${rule} ${show(cmd)} ${JSON.stringify(r.all)}`);
          assert.ok(reaches(await parseBash(cmd), target, kind), `IR ${show(cmd)}`);
        }
      }
    });
  }
}

test('varias sustituciones en un comando: se releen todas, sin duplicar', async () => {
  const cmd = `{ cat <<'X' 1<>out.txt; echo $(echo a) ${bt('echo b')} <(echo c) >(echo d) $(cp out.txt ${DOC}); }`;
  const r = await run(cmd);
  assert.ok(hits(r, 'H-10'));
  const p = await parseBash(cmd);
  for (const a of ['a', 'b', 'c', 'd']) {
    assert.equal(p.commands.filter((c) => c.words[0]?.text === 'echo' && c.words[1]?.text === a).length, 1, a);
  }
  assert.equal(named(p, 'cp').length, 1);
});

test('sustitución dentro de una sustitución con comodín: H-12 dinámico', async () => {
  for (const cmd of [`{ cat <<'X' 1<>out.txt; echo $(echo x > C''LAUDE.m?); }`, `{ cat <<'X' 1<>out.txt; echo ${bt("echo x > .cl''aude/settings.jso?")}; }`]) {
    const r = await run(cmd);
    assert.ok(r.all.some((x) => x.rule === 'H-12' && /destino dinámico/.test(x.msg)), `${cmd} ${JSON.stringify(r.all)}`);
  }
});

// ---------- 4. Heredoc: el cuerpo sin comillas se expande, con comillas no ----------
test('cuerpo de heredoc sin comillas: `…` se relee (el AST no lo representa)', async () => {
  const cmd = `cat <<X 0>out.txt\nhola ${bt(`cp out.txt ${DOC}`)} chau\nX`;
  const r = await run(cmd);
  assert.ok(hits(r, 'H-10'), JSON.stringify(r.all));
  const p = await parseBash(cmd);
  const cp = p.recovered.commands.find((c) => c.words[0]?.text === 'cp');
  assert.equal(cp.subst, '``');
  assert.ok(cmd.slice(cp.start).startsWith('cp out.txt'));
});
for (const delim of ["'X'", '"X"', '\\X']) {
  test(`cuerpo de heredoc con delimitador ${delim}: no se ejecuta, no se relee`, async () => {
    let cmd = `cat <<${delim} 0>out.txt\nhola ${bt(`cp out.txt ${DOC}`)} chau\nX`;
    const r = await run(cmd);
    assert.equal(r.decision, 'allow', JSON.stringify(r));
    assert.equal(named(await parseBash(cmd), 'cp').length, 0);
    // Con $(…) en el cuerpo, tree-sitter (no la lectura léxica) lo toma como comando: falso
    // positivo previo del AST. La lectura léxica no lo relee.
    cmd = `cat <<${delim} 0>out.txt\nhola $(cp out.txt ${DOC}) chau\nX`;
    assert.ok(!(await parseBash(cmd)).recovered.commands.some((c) => c.words[0]?.text === 'cp'));
  });
}

// ---------- 5. Comentarios y cadenas con caracteres parecidos a operadores ----------
const P = (s) => `{ cat <<'X' 1<>out.txt; ${s}; }`;
for (const s of [
  `echo '$(cp out.txt out2.txt)' '${bt('cp out.txt out2.txt')}'`,
  'echo "\\$(cp out.txt out2.txt)"',
  'echo \\`cp out.txt out2.txt\\`',
  `echo "a > b" 'c < d' "<(e)" '>(f)' 'x \`y\` z'`,
  `echo x # $(cp out.txt out2.txt) ${bt('cp a b')} <(cp c d)`,
]) {
  test(`literal/comentario ${show(P(s))}: la lectura léxica no lo toma como código`, async () => {
    const cmd = P(s);
    const r = await run(cmd);
    assert.equal(r.decision, 'allow', JSON.stringify(r));
    const p = await parseBash(cmd);
    assert.ok(!p.recovered.commands.some((c) => ['cp', 'e', 'f', 'y'].includes(c.words[0]?.text)), JSON.stringify(p.recovered.commands.map((c) => c.words.map((w) => w.raw))));
    assert.ok(!p.recovered.commands.some((c) => c.subst), 'sin sustituciones');
    assert.equal(p.recovered.ambiguous.length, 0);
  });
}

// ---------- 6. Casos legítimos ----------
for (const s of [
  `echo $(date) ${bt('pwd')} <(ls) >(cat)`,
  'diff <(sort out.txt) <(sort out2.txt)',
  'x=$(cat out.txt); echo "$x"',
  'cat <(cat out.txt) > out2.txt',
  // (`echo "$(cat out.txt)"` en este contexto da H-12 por las alternativas de P0.3-B1: falso
  // positivo previo, igual antes y después de esta etapa.)
  'echo ${x:-$(pwd)}',
  'echo $(echo x > out2.txt)',
  'echo $(( 1 + 2 )); (( n > 3 ))',
  'echo $(( 1 > 2 ))',
  '((a); (b))',
  `echo ${bt('cat < out.txt')}`,
]) {
  for (const cmd of [P(s), body(P(s))]) {
    test(`legítimo ${show(cmd)} => allow`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'allow', JSON.stringify(r));
      // La aritmética no produce redirecciones (no hay escritura al archivo '2' ni '3').
      const ws = writeTargets(await parseBash(cmd)).map((x) => x.text);
      assert.ok(ws.every((x) => ['out.txt', 'out2.txt'].includes(x)), JSON.stringify(ws));
    });
  }
}

// ---------- 7. Malformados: H-13 estructural ----------
const deep = (n) => 'echo ' + '$(echo '.repeat(n) + 'x' + ')'.repeat(n);
const deepBt = (n) => { let s = 'echo x'; for (let i = 0; i < n; i++) s = `echo ${bt(s)}`; return s; };
for (const [cmd, why] of [
  [P('echo `cp out.txt out2.txt'), /comilla invertida sin cerrar/],
  [P('echo $(cp out.txt out2.txt'), /sustitución de comandos sin cerrar/],
  [P('diff <(cp out.txt out2.txt out.txt'), /sustitución de proceso sin cerrar/],
  [P('tee >(cp out.txt out2.txt'), /sustitución de proceso sin cerrar/],
  [P('echo "$(cp out.txt out2.txt"'), /sin cerrar/],
  [P('echo `echo $(cp a b`'), /sustitución de comandos sin cerrar/],
  [P('echo ${x:-$(cp a b}'), /sin cerrar/],
  [P('echo $(( $(cp a b) + 1 )'), /sin cerrar/],
  [`{ cat <<X 1<>out.txt; }\n$(cp a b\nX`, /cuerpo de heredoc/],
  [P(deep(10)), /demasiado profundas/],
  [P(deepBt(10)), /demasiado profundas/],
]) {
  test(`malformado ${show(cmd)} => deny H-13 estructural`, async () => {
    const p = await parseBash(cmd);
    assert.ok(p.recovered.ambiguous.some((a) => why.test(a.why)), JSON.stringify(p.recovered.ambiguous));
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(structuralH13(r), JSON.stringify(r.all));
  });
}

// ---------- 8. Asociación de stdin, posiciones y deduplicación ----------
test('stdin heredado de una sustitución es dinámico; la redirección propia prevalece', async () => {
  let p = await parseBash(P('echo `bash`'));
  const b = p.recovered.commands.find((c) => c.words[0]?.text === 'bash');
  assert.equal(b.subst, '``');
  assert.equal(b.stdin.kind, 'dynamic');
  let r = await run(P('echo `bash`'));
  assert.ok(r.all.some((x) => x.rule === 'H-13' && /bash recibe por stdin código no literal/.test(x.msg)), JSON.stringify(r.all));
  r = await run(P('tee >(bash)'));
  assert.ok(r.all.some((x) => x.rule === 'H-13' && /bash recibe por stdin código no literal/.test(x.msg)), JSON.stringify(r.all));
  p = await parseBash(P('echo `cat < out.txt`'));
  const c = p.recovered.commands.find((x) => x.subst === '``' && x.words[0]?.text === 'cat');
  assert.equal(c.stdin.kind, 'file');
  assert.equal(c.stdin.target.text, 'out.txt');
});

test('posiciones de comillas invertidas anidadas se traducen al texto original', async () => {
  const cmd = P(`echo ${bt(`echo ${bt(`echo ${bt('cp a b')}`)}`)}`);
  const p = await parseBash(cmd);
  const cp = p.recovered.commands.find((c) => c.words[0]?.text === 'cp');
  assert.ok(cmd.slice(cp.start).startsWith('cp a b'), String(cp.start));
});

test('lo que el AST ya representa no se duplica', async () => {
  let p = await parseBash("echo $(cp a b)\n{ cat <<'X' 1<>out.txt; }");
  assert.equal(p.hasError, true);
  assert.equal(named(p, 'cp').length, 1);
  assert.ok(!p.recovered.commands.some((c) => c.words[0]?.text === 'cp'));
  p = await parseBash(P(`echo $(cp out.txt ${DOC})`));
  assert.equal(named(p, 'cp').length, 1);
});

test('<( ) y >( ) no son redirecciones', async () => {
  let p = await parseBash(P('diff <(cp a b) out.txt'));
  const diff = p.recovered.commands.find((c) => c.words[0]?.text === 'diff');
  assert.equal(diff.redirects.length, 0);
  assert.equal(diff.words[1].text, null);
  p = await parseBash(P('cat < <(ls)'));
  const cat = p.recovered.commands.find((c) => c.words[0]?.text === 'cat');
  assert.equal(cat.redirects.length, 1);
  assert.equal(cat.redirects[0].op, '<');
  assert.equal(cat.redirects[0].write, false);
  assert.equal(cat.redirects[0].target.text, null);
  assert.equal(named(p, 'ls').length, 1);
});

test('sin nodos ERROR no hay lectura léxica: las sustituciones las cubre el AST', async () => {
  for (const cmd of [`echo $(cp out.txt ${DOC})`, `echo ${bt(`cp out.txt ${DOC}`)}`, `diff <(cp out.txt ${DOC}) b`]) {
    const p = await parseBash(cmd);
    assert.equal(p.hasError, false);
    assert.equal(p.recovered.commands.length, 0);
    assert.equal(named(p, 'cp').length, 1);
    assert.ok(hits(await run(cmd), 'H-10'));
  }
});

// ---------- 9. guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  ["{ cat <<'X' 0>C''LAUDE.m?; }", 2, 'H-12'],
  [`{ cat <<'X' 1<>out.txt; echo \`cp out.txt ${DOC}\`; }`, 2, 'H-10'],
  [`{ cat <<'X' 1<>out.txt; diff <(cp out.txt ${DOC}) out.txt; }`, 2, 'H-10'],
  ["{ cat <<'X' 1<>out.txt; echo $(date) `pwd`; }", 0],
]) {
  test(`subst guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
