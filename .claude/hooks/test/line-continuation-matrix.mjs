// P0.3-B1.5.1: generador de la matriz de line-continuation.test.mjs. Separado para que la validación
// con Bash (`bash -n` y semántica inocua con echo) use exactamente los mismos textos. No ejecuta nada.
// `@L` es una continuación de línea real: barra invertida + salto de línea (no los caracteres `\` `n`).
import { CONTEXTS, targets } from './coproc-time-matrix.mjs';

export const BS = String.fromCharCode(92);
export const LF = String.fromCharCode(92, 10);
export const CRLF = String.fromCharCode(92, 13, 10);
export const cont = (s, c = LF) => s.replaceAll('@L', c);

// Prefijos con la continuación en cada posición: [nombre, texto, admite compuesto, admite simple].
export const PREFIXES = [
  ['después de time', 'time@L -p ', true, true],
  ['dentro de time', 'ti@Lme -p ', true, true],
  ['dentro de time (2 veces)', 't@Li@Lme -p ', true, true],
  ['continuaciones repetidas después de time', 'time@L@L -p ', true, true],
  ['antes de time', '@Ltime -p ', true, true],
  ['dentro de -p', 'time -@Lp ', true, true],
  ['después de -p', 'time -p@L ', true, true],
  ['dentro de --', 'time -p -@L- ', true, true],
  ['después de --', 'time -p --@L ', true, true],
  ['dentro de time sin opciones', 'ti@Lme ', true, true],
  ['! con time partido', '! ti@Lme -p ', true, true],
  ['después de coproc', 'coproc@L ', true, true],
  ['dentro de coproc', 'co@Lproc ', true, true],
  ['antes del nombre', 'coproc@L NOMBRE ', true, false],
  ['después del nombre', 'coproc NOMBRE@L ', true, false],
  ['dentro del nombre', 'coproc NOM@LBRE ', true, false],
  ['coproc y nombre partidos', 'cop@Lroc N@L ', true, false],
  ['time -p coproc partido', 'time -p co@Lproc ', true, true],
  ['coproc asignación partida', 'coproc x@L=1 ', false, true],
];

// Cuerpos compuestos con la continuación dentro o después de palabras reservadas y operadores.
// `@CP` = `@P out.txt @T` (programa y destino). `sem: false`: sin ejecución inocua.
export const COMPOUND = [
  ['bloque', '{ @CP; }'],
  ['después de {', '{@L @CP; }'],
  ['antes de }', '{ @CP; @L}'],
  ['dentro de then', 'if true; the@Ln @CP; fi'],
  ['dentro de if', 'i@Lf true; then @CP; fi'],
  ['dentro de fi', 'if true; then @CP; f@Li'],
  ['dentro de do (while)', 'while true; d@Lo @CP; break; done'],
  ['dentro de while', 'wh@Lile true; do @CP; break; done'],
  ['dentro de done', 'until false; do @CP; break; do@Lne'],
  ['dentro de do (for)', 'for i in 1; d@Lo @CP; done'],
  ['dentro de for', 'f@Lor i in 1; do @CP; done'],
  ['dentro de case', 'ca@Lse a in a) @CP;; esac'],
  ['dentro de in', 'case a i@Ln a) @CP;; esac'],
  ['dentro de esac', 'case a in a) @CP;; es@Lac'],
  ['subshell', '(@L @CP )'],
  ['antes de un operador', '{ :@L; @CP; }'],
  ['después de un operador', '{ :;@L @CP; }'],
  ['después de &&', '{ : &&@L @CP; }'],
  ['después de |', '{ echo |@L @CP; }'],
  ['bloques anidados', '{ {@L @CP; }; }'],
  ['bloque dentro de if', 'if true; the@Ln {@L @CP; }; fi'],
  ['dentro del programa', '{ @CPP; }'],
  ['dentro del destino', '{ @CPT; }'],
];

// Cuerpos simples (después del prefijo va directamente el comando).
export const SIMPLE = [
  ['simple', '@CP'],
  ['programa partido', '@CPP'],
  ['destino partido', '@CPT'],
  ['simple con pipe', '@CP@L | cat'],
];

// Sin time/coproc: continuaciones en palabras reservadas que B1.3/B1.4 volvían a exponer.
export const BARE = [
  ['case partido', 'ca@Lse a in a) @CP;; esac'],
  ['esac partido', 'case a in a) @CP;; es@Lac'],
  ['then partido', 'if true; the@Ln @CP; fi'],
  ['do partido', 'while true; d@Lo @CP; break; done'],
  ['{ partido', '{@L @CP; }'],
  ['programa partido', '@CPP'],
  ['destino partido', '@CPT'],
  ['function f case partido', 'function f ca@Lse a in a) @CP;; esac; f'],
  ['f() case partido', 'f() ca@Lse a in a) @CP;; esac; f'],
  ['coproc case partido', 'coproc ca@Lse a in a) @CP;; esac'],
];

// Programa: literal o con comillas que se eliminan (c''p).
const PROGS = ['cp', "c''p", 'cp', '"cp"'];

/** Inserta una continuación en la palabra (después del 3er carácter). */
const split = (w) => `${w.slice(0, 3)}@L${w.slice(3)}`;

/** Casos: [nombre, texto, destino esperado, regla, texto inocuo (o null)]. */
export function matrix(froot, c = LF) {
  const T = targets(froot);
  const out = [];
  let k = 0;
  const add = (name, prefix, body, ctx, opts = {}) => {
    const [t, rule, word] = T[k % T.length];
    const prog = PROGS[k % PROGS.length];
    k++;
    const fill = (p, tg) => body.replace('@CPP', `${p === 'cp' ? 'c@Lp' : p.replace('c', 'c@L')} out.txt ${tg}`)
      .replace('@CPT', `${p} out.txt ${split(tg)}`).replace('@CP', `${p} out.txt ${tg}`);
    const s = cont(prefix + fill(prog, word), c);
    const [cn, cf, sf] = ctx;
    // Inocuo: el comando pasa a ser `echo LEAK >&2`, partido igual (programa o argumento).
    const harmless = body.replace('@CPP', 'ec@Lho LEAK >&2').replace('@CPT', 'echo LE@LAK >&2').replace('@CP', 'echo LEAK >&2');
    const sem = sf && opts.sem !== false ? sf(cont(prefix + harmless, c)) : null;
    out.push([`${name} | ${cn}`, cf(s), t, rule, sem]);
  };
  let j = 0;
  const nextCtx = () => CONTEXTS[j++ % CONTEXTS.length];
  for (const [pn, pre, comp, simp] of PREFIXES) {
    const [bn, body] = comp ? COMPOUND[0] : SIMPLE[0];
    for (const ctx of CONTEXTS) add(`${pn} | ${bn}`, pre, body, ctx);
    if (comp) for (const [b2, body2] of COMPOUND.slice(1)) add(`${pn} | ${b2}`, pre, body2, nextCtx());
    if (simp) for (const [b2, body2] of SIMPLE.slice(comp ? 0 : 1)) add(`${pn} | ${b2}`, pre, body2, nextCtx());
  }
  for (const [bn, body] of BARE) for (const ctx of CONTEXTS) add(`sin prefijo | ${bn}`, '', body, ctx);
  return out;
}

// Otras reglas (H-01, H-02, H-04, SEC) con la continuación en el programa, una opción o el argumento.
// [nombre, texto, reglas aceptadas]. H-07: un programa sensible escrito en forma no canónica.
export const DANGER = [
  ['push --force partido', 'git push --for@Lce origin x', ['H-01']],
  ['push -f después de continuación', 'git push@L -f origin x', ['H-01']],
  ['push partido', 'git pu@Lsh --force origin x', ['H-01', 'H-07']],
  ['git partido', 'g@Lit push --force origin x', ['H-01', 'H-07']],
  ['+refspec partido', 'git push origin +ma@Lin', ['H-01']],
  ['reset --hard partido', 'git reset --ha@Lrd', ['H-02']],
  ['reset partido', 'git re@Lset --hard', ['H-02', 'H-07']],
  ['reset después de continuación', 'git reset@L --hard HEAD', ['H-02']],
  ['sudo partido', 'su@Ldo ls', ['H-04']],
  ['sudo antes de continuación', 'sudo@L ls', ['H-04']],
  ['.env partido', 'cat .en@Lv', ['SEC']],
  ['secrets partido', 'cat backend/sec@Lrets/x.json', ['SEC']],
  ['.env entre comillas dobles partido', 'cat ".en@Lv"', ['SEC']],
  ['time + push --force', 'time@L -p git push --force origin x', ['H-01']],
  ['coproc + push --force', 'coproc@L git push --force', ['H-01']],
  ['coproc + reset', 'co@Lproc git reset --hard', ['H-02']],
  ['time { sudo }', 'time -p {@L sudo ls; }', ['H-04']],
  ['then + reset', 'time -p if true; the@Ln git reset --hard; fi', ['H-02']],
  ['case + sudo', 'time -p ca@Lse a in a) sudo ls;; esac', ['H-04']],
  ['time + cat .env', 'ti@Lme cat .env', ['SEC']],
];

// Comandos legítimos con `case` (sustituto: la lista de la auditoría B1.4 no está en el repositorio).
export const LEGIT_CASE = [
  'case a in a) echo ok;; esac',
  'case "$1" in start) echo s;; stop) echo t;; *) echo u;; esac',
  'case $x in a|b) echo ab;; esac',
  'case $x in (a) echo a;; esac',
  'case $x in *.md) echo md;; *.txt) echo txt;; esac',
  'case $x in a) echo a;& b) echo b;; esac',
  'case $x in a) echo a;;& *) echo any;; esac',
  'case "$(uname)" in Linux) echo l;; esac',
  'case $x in [0-9]) echo d;; esac',
  'for f in *.md; do case $f in README.md) continue;; esac; echo $f; done',
  'while read l; do case $l in "#"*) ;; *) echo "$l";; esac; done < input.txt',
  'if true; then case a in a) echo ok;; esac; fi',
  'echo "$(case a in a) echo ok;; esac)"',
  'x=$(case a in a) echo 1;; esac)',
  'cat <(case a in a) echo ok;; esac)',
  'diff <(case a in a) echo 1;; esac) <(echo 1)',
  'f() { case $1 in a) echo a;; esac; }; f a',
  'function g { case $1 in b) echo b;; esac; }; g b',
  'case a in a) ls;; esac | wc -l',
  'case a in a) echo ok;; esac > /dev/null',
  'case a in a) echo ok;; esac && echo done',
  '{ case a in a) echo ok;; esac; }',
  '( case a in a) echo ok;; esac )',
  'time -p case a in a) echo ok;; esac',
  '! case a in a) false;; esac',
  'case a in\n a) echo ok\n ;;\nesac',
  'case a in a) echo "case esac";; esac',
  'echo case in esac',
  'grep -n "case" src/file.ts',
  'git log --grep=case',
  'case $x in a) echo a ;; b) echo b ;; esac',
  'case $x in ?) echo one;; ??) echo two;; esac',
  'case $x in a) case $y in b) echo ab;; esac;; esac',
  'case $x in a) echo $(date);; esac',
  'case $x in a) echo `date`;; esac',
  'case $x in a) cat <<EOF\nhola\nEOF\n;; esac',
  'select o in a b; do case $o in a) break;; esac; done',
  'until false; do case a in a) break;; esac; done',
  'case "$OSTYPE" in msys*) echo win;; darwin*) echo mac;; esac',
  'case $# in 0) echo none;; esac',
  'case ${1:-x} in x) echo def;; esac',
  'coproc { case a in a) echo ok;; esac; }',
  'echo "$(time -p case a in a) echo ok;; esac)"',
  'case a in a) ls -la;; esac; echo after',
  '[[ $x == a ]] && case $x in a) echo a;; esac',
  'case a in a) echo ok;; esac # comentario con case',
];
/** Variantes legítimas: tal cual, con una continuación entre palabras y con `case` partido. */
export const legitVariants = (s) => [s, s.replace(' ', ' @L'), s.replace('case', 'ca@Lse')].map((x) => cont(x));
