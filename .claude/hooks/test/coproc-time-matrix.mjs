// P0.3-B1.5: generador de la matriz de coproc-time.test.mjs. Separado para que la validación con
// Bash (`bash -n` y semántica inocua con echo) use exactamente los mismos textos. No ejecuta nada.

// Prefijos: [nombre, texto, admite compuesto, admite comando simple, opciones].
export const PREFIXES = [
  ['coproc', 'coproc ', true, true],
  ['coproc NOMBRE', 'coproc NOMBRE ', true, false],
  ['coproc "N"', 'coproc "N" ', true, false],
  ['coproc NOMBRE con tabs', 'coproc\tNOMBRE\t', true, false],
  ['time', 'time ', true, true],
  ['time -p', 'time -p ', true, true],
  ['time --', 'time -- ', true, true],
  ['time -p --', 'time -p -- ', true, true],
  ['! time -p', '! time -p ', true, true],
  ['! time', '! time ', true, true],
  ['time con tabs', 'time\t-p\t', true, true],
  ['time -p coproc', 'time -p coproc ', true, true],
  // Después de coproc, time es un programa (/usr/bin/time); no existe en Git Bash: sin semántica.
  ['coproc time (programa)', 'coproc time ', false, true, { sem: false }],
  ['coproc asignación', 'coproc x=1 ', false, true],
  ['coproc redirección', 'coproc >/dev/null ', false, true],
  ['time -p asignación', 'time -p x=1 ', false, true],
];

// Cuerpos compuestos: `@CP` es el comando que escribe. `sem: false` = no se ejecuta la versión
// inocua (redirección a /dev/null o select, que espera stdin).
export const COMPOUND = [
  ['bloque', '{ @CP; }'],
  // ':' y no 'echo': un echo al stdout del coproc sin lector termina con SIGPIPE antes del cp.
  ['bloque con otro comando antes', '{ :; @CP; }'],
  ['subshell', '( @CP )'],
  ['if/then', 'if true; then @CP; fi'],
  ['if/else', 'if false; then :; else @CP; fi'],
  ['while', 'while true; do @CP; break; done'],
  ['until', 'until false; do @CP; break; done'],
  ['for', 'for i in 1; do @CP; done'],
  ['select', 'select x in a; do @CP; break; done', { sem: false }],
  ['case', 'case a in a) @CP;; esac'],
  ['bloques anidados', '{ { @CP; }; }'],
  ['bloque dentro de if', 'if true; then { @CP; }; fi'],
  ['pipe dentro', '{ echo | @CP; }'],
  ['pipe después', '{ @CP; } | cat'],
  ['redirección después', '{ @CP; } 2>/dev/null', { sem: false }],
  ['heredoc dentro', '{ cat <<H\nx\nH\n@CP; }'],
  ['&& después', '{ @CP; } && echo'],
  ['saltos de línea', '{\n@CP\n}'],
];

// Cuerpos simples (después del prefijo va directamente el comando).
export const SIMPLE = [
  ['simple', '@CP'],
  ['simple con pipe', '@CP | cat'],
  ['simple con &&', '@CP && echo'],
  ['simple con here-string', '@CP <<<x'],
];

// Envolturas: `@` es PREFIJO+CUERPO. La tercera función da el equivalente inocuo (o null).
export const CONTEXTS = [
  ['directo', (s) => s, (s) => s],
  ['bloque con ERROR', (s) => `{ cat <<'X' 1<>out.txt; ${s}; }`, null],
  ['subshell', (s) => `( ${s} )`, (s) => `( ${s} )`],
  ['bloque', (s) => `{ ${s}; }`, (s) => `{ ${s}; }`],
  ['$() entre comillas', (s) => `echo "$(${s})"`, (s) => `echo "$(${s})"`],
  ['<()', (s) => `cat <(${s})`, (s) => `cat <(${s})`],
  ['>()', (s) => `tee >(${s}) </dev/null`, (s) => `echo >(${s}); wait`],
  ['asignación $()', (s) => `x=$(${s})`, (s) => `x=$(${s}); echo "$x"`],
  ['heredoc sin comillas', (s) => `cat <<E\n$(${s})\nE`, (s) => `cat <<E\n$(${s})\nE`],
  ['dentro de if', (s) => `if true; then ${s}; fi`, (s) => `if true; then ${s}; fi`],
  ['después de &&', (s) => `true && ${s}`, (s) => `true && ${s}`],
  ['comandos antes y después', (s) => `echo a; ${s}; echo c`, (s) => `echo a; ${s}; echo c`],
];

/** Destinos: [texto esperado en el cp de la IR, regla, palabra escrita en el comando]. */
export function targets(froot) {
  return [
    ['docs/MODULO_02_HANDOFF.md', 'H-10', 'docs/MODULO_02_HANDOFF.md'],
    ['CLAUDE.md', 'H-12', 'CLAUDE.md'],
    ['.claude/settings.json', 'H-12', '.claude/settings.json'],
    ['.git/config', 'H-12', '.git/config'],
    [`${froot}/docs/MODULO_01_HANDOFF_FASE_C.md`, 'H-10', `${froot}/docs/MODULO_01_HANDOFF_FASE_C.md`],
    ['docs/FRONTEND_PANTALLAS_PLAN.md', 'H-10', 'do"cs/FRONTEND_"PANTALLAS_PLAN.md'],
    ['.claude/settings.json', 'H-12', ".cla''ude/sett\"\"ings.json"],
  ];
}
// Programa: literal o con comillas que se eliminan (c''p).
const PROGS = ['cp', "c''p", 'cp', '"cp"'];

/** Casos: [nombre, texto, destino esperado, regla, texto inocuo (o null)]. */
export function matrix(froot) {
  const T = targets(froot);
  const out = [];
  let k = 0;
  const add = (name, prefix, body, ctx, opts = {}, popts = {}) => {
    const [t, rule, word] = T[k % T.length];
    const prog = PROGS[k % PROGS.length];
    k++;
    const s = prefix + body.replace('@CP', `${prog} out.txt ${word}`);
    const [cn, cf, sf] = ctx;
    // Inocuo: el cp pasa a ser `echo LEAK >&2` (stderr: también se ve desde un coproc).
    const sem = sf && opts?.sem !== false && popts?.sem !== false ? sf(prefix + body.replace('@CP', 'echo LEAK >&2')) : null;
    out.push([`${name} | ${cn}`, cf(s), t, rule, sem]);
  };
  let j = 0;
  const nextCtx = () => CONTEXTS[j++ % CONTEXTS.length];
  for (const [pn, pre, comp, simp, po] of PREFIXES) {
    // Prefijo × envoltura con el cuerpo base.
    const [bn, body, bo] = comp ? COMPOUND[0] : SIMPLE[0];
    for (const ctx of CONTEXTS) add(`${pn} | ${bn}`, pre, body, ctx, bo, po);
    // Prefijo × cuerpo, con envoltura rotativa.
    if (comp) for (const [b2, body2, bo2] of COMPOUND.slice(1)) add(`${pn} | ${b2}`, pre, body2, nextCtx(), bo2, po);
    if (simp) for (const [b2, body2, bo2] of SIMPLE.slice(comp ? 0 : 1)) add(`${pn} | ${b2}`, pre, body2, nextCtx(), bo2, po);
  }
  return out;
}
