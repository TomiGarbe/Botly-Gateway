// P0.3-B1.5.1: continuaciones de línea (`\` + salto de línea). Bash las elimina antes de separar
// palabras y operadores, también dentro de una palabra: `ti\⏎me` es `time` y `the\⏎n` es `then`.
// tree-sitter-bash las toma como un espacio (`ti` `me`) sin nodos ERROR, y el lector léxico comparaba
// palabras reservadas y prefijos sobre el texto original con la continuación adentro: `time`, `coproc`,
// `{`, `then`, `case`, `-p` dejaban de reconocerse y el comando interno se perdía o se deduplicaba
// contra un comando del AST que la política no evalúa igual.
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
import { BS, CRLF, DANGER, LEGIT_CASE, LF, cont, legitVariants, matrix } from './line-continuation-matrix.mjs';
import { makeFixture } from './fixture.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = makeFixture();
const froot = root.split('\\').join('/');
const DOC = 'docs/MODULO_02_HANDOFF.md';
const show = (cmd) => JSON.stringify(cmd.replaceAll(froot, '<FROOT>'));

const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });
const VOCAB_MSG = /toca algo sensible|junto a un intérprete|vocabulario sensible/;
const structuralH13 = (r) => r.all.some((x) => x.rule === 'H-13' && !VOCAB_MSG.test(x.msg));
const rulesOf = (r) => [...new Set(r.all.map((x) => x.rule))];
const unTime = (ws) => { let k = 0; if (ws[k]?.text === 'time') { k++; if (ws[k]?.text === '-p') k++; if (ws[k]?.text === '--') k++; } return ws.slice(k); };
const cpTo = (p, t) => p.commands.some((c) => unTime(c.words)[0]?.text === 'cp' && unTime(c.words)[2]?.text === t);
const findCmd = (p, words) => p.commands.find((c) => c.lexical && words.every((w, i) => c.words[i]?.text === w));
const logical = (s) => s.replace(/\\\r?\n/g, '');

// ---------- AST real: la causa ----------
const vendor = (p) => path.join(HOOKS, 'vendor', p);
const ts = await import(pathToFileURL(vendor('web-tree-sitter/web-tree-sitter.js')).href);
await ts.Parser.init({ locateFile: () => vendor('web-tree-sitter/web-tree-sitter.wasm') });
const parser = new ts.Parser();
parser.setLanguage(await ts.Language.load(vendor('tree-sitter-bash/tree-sitter-bash.wasm')));
const ast = (src, fn) => { const t = parser.parse(src); try { return fn(t.rootNode); } finally { t.delete(); } };

test('AST: tree-sitter parte la palabra en la continuación, sin ERROR (Bash la une)', () => {
  for (const [src, first] of [[cont('ti@Lme -p ls'), 'ti'], [cont('co@Lproc ls'), 'co'], [cont('echo ti@Lme'), 'echo']]) {
    ast(src, (r) => {
      assert.equal(r.hasError, false, src);
      const cmd = r.descendantsOfType('command')[0];
      assert.equal(cmd.namedChildren[0].text, first, src);
    });
  }
  // `time\⏎ -p {`: `time` es el programa y `{`, `cp` sus argumentos.
  ast(cont(`time@L -p { cp out.txt ${DOC}; }`), (r) => {
    assert.equal(r.hasError, false);
    assert.equal(r.descendantsOfType('command').some((c) => c.namedChildren[0].text === 'cp'), false);
  });
});

// ---------- 1. Reproducciones obligatorias ----------
const REPRO = [
  [cont(`time@L -p { cp out.txt ${DOC}; }`), ['cp', 'out.txt', DOC], 'H-10'],
  [cont('coproc@L git push --force'), ['git', 'push', '--force'], 'H-01'],
  [cont(`echo "$(time@L -p case a in a) cp out.txt CLAUD${BS}E.md;; esac)"`), ['cp', 'out.txt', 'CLAUDE.md'], 'H-12'],
  [cont('time -p {@L sudo ls; }'), ['sudo', 'ls'], 'H-04'],
  [cont('time -p if true; the@Ln git reset --hard; fi'), ['git', 'reset', '--hard'], 'H-02'],
];
const RCTX = [
  ['directo', (s) => s],
  ['bloque con ERROR', (s) => `{ cat <<'X' 1<>out.txt; ${s}; }`],
  ['subshell', (s) => `( ${s} )`],
  ['$()', (s) => `echo "$(${s})"`],
];
for (const [base, words, rule] of REPRO) {
  for (const [cn, cf] of RCTX) {
    const cmd = cf(base);
    test(`reproducción ${cn} ${show(cmd)} => deny ${rule}`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'deny', JSON.stringify(r));
      assert.ok(rulesOf(r).includes(rule), JSON.stringify(r.all));
      const p = await parseBash(cmd);
      const c = findCmd(p, words);
      assert.ok(c, `comando ${words.join(' ')} reconstruido: ${JSON.stringify(p.commands.map((x) => x.words.map((w) => w.text)))}`);
      // Posición en el texto original: desde ahí, sin continuaciones, empieza el comando.
      assert.ok(logical(cmd.slice(c.start)).startsWith(words[0]), `posición ${c.start}`);
      assert.equal(p.commands.filter((x) => x.lexical && words.every((w, i) => x.words[i]?.text === w)).length, 1, 'una sola vez');
    });
  }
}
for (const [base] of REPRO) {
  const cmd = base.replaceAll(LF, CRLF);
  test(`reproducción con CRLF ${show(cmd)} => deny H-13 (Git Bash une, Linux no)`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny');
    assert.ok(structuralH13(r), JSON.stringify(r.all));
    assert.ok((await parseBash(cmd)).recovered.ambiguous.some((a) => /CRLF/.test(a.why)));
  });
}

// ---------- 2. Matriz: posición de la continuación × prefijo/compuesto × envoltura ----------
const M = matrix(froot);
test('matriz: tamaño esperado', () => assert.ok(M.length >= 800, String(M.length)));
for (const [name, cmd, t, rule] of M) {
  test(`matriz ${name} ${show(cmd)} => deny ${rule}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.ok(rulesOf(r).includes(rule), JSON.stringify(r.all));
    assert.ok(cpTo(await parseBash(cmd), t), `cp a ${t} en la IR`);
  });
}

// ---------- 3. Otras reglas: H-01, H-02, H-04, SEC ----------
const DCTX = [
  ['directo', (s) => s],
  ['bloque con ERROR', (s) => `{ cat <<'X' 1<>out.txt; ${s}; }`],
  ['$()', (s) => `echo "$(${s})"`],
  ['<()', (s) => `cat <(${s})`],
];
for (const [name, s, ok] of DANGER) {
  for (const [cn, cf] of DCTX) {
    const cmd = cf(cont(s));
    test(`regla ${ok.join('/')} ${name} ${cn} ${show(cmd)} => deny`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'deny', JSON.stringify(r));
      assert.ok(rulesOf(r).some((x) => ok.includes(x)), JSON.stringify(r.all));
    });
  }
  const crlf = cont(s, CRLF);
  test(`regla ${ok.join('/')} ${name} con CRLF ${show(crlf)} => deny`, async () => {
    assert.equal((await run(crlf)).decision, 'deny');
  });
}

// ---------- 4. Operadores y expansiones partidos: ambiguos (H-13 estructural) ----------
for (const [s, why] of [
  ['true &@L& cp out.txt CLAUDE.md', /operador/],
  ['false |@L| cp out.txt CLAUDE.md', /operador/],
  ['echo x >@L> CLAUDE.md', /operador/],
  [`cat <@L<X${'\n'}hola${'\n'}X${'\n'}cp out.txt CLAUDE.md`, /operador/],
  ['cat <@L(cp out.txt CLAUDE.md)', /operador/],
  ['(@L(1)) && cp out.txt CLAUDE.md', /operador/],
  ['case a in a) :;@L; b) cp out.txt CLAUDE.md;; esac', /operador/],
  ['echo "$@L(cp out.txt CLAUDE.md)"', /después de \$/],
  ['echo $@L(cp out.txt CLAUDE.md)', /después de \$/],
  ['x=$@L{y:-$(cp out.txt CLAUDE.md)}', /después de \$/],
  [`cat <<X${'\n'}$@L(cp out.txt CLAUDE.md)${'\n'}X`, /después de \$/],
]) {
  // Con un heredoc en el texto, la envoltura con otro heredoc abierto no es un fixture válido.
  for (const cmd of s.includes('\n') ? [cont(s)] : [cont(s), `{ cat <<'X' 1<>out.txt; ${cont(s)}; }`]) {
    test(`ambiguo ${show(cmd)} => deny H-13`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'deny', JSON.stringify(r));
      assert.ok(structuralH13(r), JSON.stringify(r.all));
      assert.ok((await parseBash(cmd)).recovered.ambiguous.some((a) => why.test(a.why)), 'motivo');
    });
  }
}

// ---------- 5. Heredocs ----------
test('heredoc sin comillas: `X\\⏎` + línea vacía es el delimitador y lo que sigue se ejecuta', async () => {
  for (const cmd of [cont('cat <<X\nX@L\n\ncp out.txt CLAUDE.md\nX'), cont('cat <<-X\n\tX@L\n\ncp out.txt CLAUDE.md\nX')]) {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', cmd);
    assert.ok(rulesOf(r).includes('H-12'));
    assert.ok(cpTo(await parseBash(cmd), 'CLAUDE.md'));
  }
});
test('heredoc: continuación entre << y el delimitador', async () => {
  const cmd = cont('cat << @LX\nhola\nX\ncp out.txt CLAUDE.md');
  assert.ok(cpTo(await parseBash(cmd), 'CLAUDE.md'));
  assert.equal((await run(cmd)).decision, 'deny');
});
test('heredoc: `\\\\⏎` es una barra escapada (no une) y `a\\⏎X` une (no es delimitador)', async () => {
  // Bash: `a\\` + `X` -> el cuerpo termina en X y cp se ejecuta.
  let p = await parseBash(`cat <<X\na${BS}${BS}\nX\ncp out.txt CLAUDE.md\nX`);
  assert.ok(cpTo(p, 'CLAUDE.md'));
  // Bash: `a\` + `X` = `aX` (cuerpo); la línea de echo sigue en el cuerpo y no es un comando léxico.
  p = await parseBash(cont('cat <<X\na@LX\necho dentro\nX'));
  assert.equal(p.commands.some((c) => c.lexical && c.words[0]?.text === 'echo'), false);
});
test('heredoc con comillas: el cuerpo es literal, la continuación no une (el lector no agrega el cp)', async () => {
  const cmd = cont("cat <<'X'\nX@L\n\ncp out.txt CLAUDE.md\nX");
  const p = await parseBash(cmd);
  assert.equal(p.commands.some((c) => c.lexical && c.words[0]?.text === 'cp'), false);
  // Bash no ejecuta ese cp (está en el cuerpo). tree-sitter sí lo toma como comando: falso positivo
  // conservador del AST, anterior a esta etapa; se registra, no se corrige acá.
  assert.ok(p.commands.some((c) => !c.lexical && c.words[0]?.text === 'cp'));
});

// ---------- 6. Controles negativos y comandos legítimos ----------
const NEGATIVE = [
  'time@Lls', 'echo ti@Lme', `${BS}time -p ls`, '"time" -p ls', "t''ime -p ls", "echo 'ti@Lme'", 'echo "co@Lproc"',
  "printf '%s\\n' \"a@Lb\"", "echo $'a@Lb'", 'time -p@L ls -la', 'time@L ls', 'coproc@L cat', 'coproc N@L { cat; }',
  'ls -la@L /tmp', 'grep -rn foo@L src/', 'git status@L --short', 'git log --oneline@L -5', 'echo a &&@L echo b',
  'echo a |@L cat', 'cat <<X\nti@Lme\nX', "cat <<'X'\nX@L\n\nX", 'echo a # comentario @L\necho b', `echo a${BS}${BS}\necho b`,
  'x@L=1 ls', 'echo "a@Lb" | wc -c', 'time -p -- ls', 'echo -@Lp',
];
for (const s of NEGATIVE) {
  // `git` después de un árbol con ERROR ya era H-13 (vocabulario sensible) sin continuaciones.
  for (const cmd of s.startsWith('git') ? [cont(s)] : [cont(s), `cat <<'Y' 0>out.txt\nc\nY\n${cont(s)}`]) {
    test(`control negativo ${show(cmd)} => allow`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'allow', JSON.stringify(r));
    });
  }
}
test('IR: palabras citadas o escapadas no se vuelven reservadas', async () => {
  for (const [s, prog] of [['"time" -p ls', '-p'], [`${BS}ti@Lme -p ls`, 'time'], ["ti''me -p ls", 'time'], ['"ti@Lme" ls', 'time']]) {
    const p = await parseBash(cont(s));
    const lex = p.commands.filter((c) => c.lexical);
    // Si el lector releyó, el programa es la palabra citada, nunca `ls` con `time` como prefijo.
    for (const c of lex) assert.equal(c.words[0].text, prog, `${s}: ${JSON.stringify(c.words.map((w) => w.text))}`);
  }
  // `echo ti\⏎me`: `time` es un argumento.
  const p = await parseBash(cont('echo ti@Lme'));
  assert.deepEqual(p.commands.filter((c) => c.lexical).map((c) => c.words.map((w) => w.text)), [['echo', 'time']]);
});

test('legítimos con case: 46', () => assert.equal(LEGIT_CASE.length, 46));
for (const s of LEGIT_CASE) {
  for (const cmd of legitVariants(s)) {
    test(`legítimo con case ${show(cmd)} => allow`, async () => {
      const r = await run(cmd);
      assert.equal(r.decision, 'allow', JSON.stringify(r));
    });
  }
}

// ---------- 7. Deduplicación y posiciones ----------
test('dedup: `time\\⏎ -p ls` no agrega un ls léxico (el lector reconoció time)', async () => {
  const p = await parseBash(cont('time@L -p ls'));
  assert.equal(p.recovered.commands.length, 0, JSON.stringify(p.recovered.commands.map((c) => c.words.map((w) => w.text))));
});
test('dedup: comandos con continuaciones entre palabras no se duplican', async () => {
  for (const s of ['ls -la@L /tmp', 'echo a@L; echo b', 'echo "$(ls@L -la)"', 'git status@L --short | cat', 'ls; ls@L -la; ls']) {
    const p = await parseBash(cont(s));
    assert.equal(p.recovered.commands.length, 0, `${s}: ${JSON.stringify(p.recovered.commands.map((c) => c.words.map((w) => w.text)))}`);
  }
});
test('dedup fail-closed: `time -p {\\⏎ ls; }` conserva el ls léxico aunque el AST tenga `time -p { ls`', async () => {
  const p = await parseBash(cont('ls; time -p {@L ls; }; ls'));
  const ls = p.recovered.commands.filter((c) => c.words[0]?.text === 'ls');
  assert.equal(ls.length, 1, 'sólo el del bloque');
  assert.ok(logical(cont('ls; time -p {@L ls; }; ls').slice(ls[0].start)).startsWith('ls; }'));
  assert.equal(ls[0].timed, undefined);
});
test('dedup: anidados en $() y <() con continuación se reconstruyen una vez', async () => {
  const cmd = cont(`echo "$(cat <(ti@Lme -p { cp out.txt ${DOC}; }))"`);
  const p = await parseBash(cmd);
  const cps = p.commands.filter((c) => c.words[0]?.text === 'cp');
  assert.equal(cps.length, 1);
  assert.equal(cps[0].subst, '<()');
  assert.ok(logical(cmd.slice(cps[0].start)).startsWith('cp out.txt'));
});
test('posiciones: la continuación dentro del programa no corre el inicio', async () => {
  for (const s of [`c@Lp out.txt ${DOC}`, `{ c@Lp out.txt ${DOC}; }`, `time -p { ${'"c@Lp"'} out.txt ${DOC}; }`]) {
    const cmd = cont(s);
    const p = await parseBash(cmd);
    const c = p.commands.find((x) => x.lexical && x.words[0]?.text === 'cp');
    assert.ok(c, s);
    assert.match(cmd.slice(c.start), /^"?c\\\n/, s);
  }
});
test('IR: asignación y descriptor partidos', async () => {
  let p = await parseBash(cont('coproc x@L=1 ls'));
  let c = findCmd(p, ['ls']);
  assert.ok(c);
  assert.equal(c.assigns[0]?.name, 'x');
  p = await parseBash(cont('{ cat <<X 1<>out.txt; echo hola 2@L>&1; }\nX'));
  assert.equal(p.commands.some((x) => x.lexical && x.words.some((w) => w.text === '2')), false, 'el 2 es el descriptor');
});
test('modo POSIX partido por una continuación sigue siendo indicio', async () => {
  const p = await parseBash(cont('set -o pos@Lix\necho "$(time -p case a in a) echo;; esac; cp out.txt CLAUDE.md)"'));
  assert.ok(p.recovered.ambiguous.some((a) => /POSIX/.test(a.why)));
});

// ---------- 8. guard.mjs (proceso real) ----------
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });
for (const [cmd, status, rule] of [
  ...REPRO.map(([c, , r]) => [c, 2, r]),
  [cont(`ti@Lme -p { cp out.txt ${DOC}; }`), 2, 'H-10'],
  [REPRO[0][0].replace(LF, CRLF), 2, 'H-13'],
  [cont('time@L -p ls'), 0],
  [cont('echo ti@Lme'), 0],
]) {
  test(`line-continuation guard.mjs ${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
