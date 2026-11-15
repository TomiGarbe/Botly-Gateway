// P0.3-B1.4: generador de la matriz de case-prefix.test.mjs. Separado para que la validación de
// sintaxis (`bash -n`) y la semántica inocua (sólo echo) se hagan sobre exactamente los mismos
// textos, fuera de la suite. Este módulo no ejecuta nada.

// Prefijos delante de `case`. `sem: false` = Bash los acepta sintácticamente pero en ejecución el
// texto no llega a mostrar el efecto (nombre de función inválido).
export const PREFIXES = [
  // Los seis obligatorios.
  ['time -p', 'time -p '],
  ['time -p --', 'time -p -- '],
  ['! time -p', '! time -p '],
  ['coproc', 'coproc '],
  ['coproc NOMBRE', 'coproc NOMBRE '],
  ['function NOMBRE', 'function f '],
  // Variantes.
  ['time', 'time '],
  ['time --', 'time -- '],
  ['! time -p --', '! time -p -- '],
  ['! time', '! time '],
  ['time time -p', 'time time -p '],
  ['time -p !', 'time -p ! '],
  ['time con tabs', 'time\t-p\t'],
  ['time -p + salto', 'time -p\n'],
  ['coproc "N"', 'coproc "N" '],
  ['coproc NOMBRE + tab', 'coproc\tNOMBRE\t'],
  ['function NOMBRE()', 'function f() '],
  ['function NOMBRE ( )', 'function f ( ) '],
  ['NOMBRE()', 'f() '],
  ['function NOMBRE + salto', 'function f\n'],
  ['function "NOMBRE"', 'function "f" ', { sem: false }],
];

// Cuerpos: `@CP` es el comando que escribe sobre el destino. `sem: false` = no se ejecuta en la
// validación semántica (redirección de escritura, aunque sea a /dev/null).
export const BODIES = [
  ['cp después de esac', 'case a in a) echo;; esac; @CP'],
  ['cp en el cuerpo', 'case a in a) @CP;; esac'],
  ['patrón con |', 'case a in b|a) echo;; esac; @CP'],
  ['patrón con ( inicial', 'case a in (a) echo;; esac; @CP'],
  ['extglob', 'case a in @(a|b)) echo;; esac; @CP'],
  [';& y ;;&', 'case a in b) :;; a) echo;& c) echo;;& *) echo;; esac; @CP'],
  ['case anidado', 'case a in a) case b in b) echo;; esac;; esac; @CP'],
  ['case anidado con prefijo', 'case a in a) time -p case b in b) echo;; esac;; esac; @CP'],
  ['comentario con )', 'case a in a) # )\necho;; esac; @CP'],
  // Salto de línea después de esac: Bash 5.2 reimprime el $() con heredoc y pierde el ';' (error en
  // ejecución, no en `bash -n`); con salto de línea las dos lecturas coinciden.
  ['heredoc con ) en el cuerpo', 'case a in a) cat <<H\n)\nH\n;; esac\n@CP'],
  ['heredoc citado con ) ( #', "case a in a) cat <<'H'\n( # ) ;\nH\n;; esac\n@CP"],
  ['comillas con )', `case a in a) echo ')' ")";; esac; @CP`],
  ['saltos de línea', 'case a\nin\na)\necho\n;;\nesac\n@CP'],
  ['tabs', 'case\ta\tin\ta)\techo;;\tesac;\t@CP'],
  ['redirección después de esac', 'case a in a) echo;; esac >/dev/null; @CP', { sem: false }],
  ['pipe después de esac', 'case a in a) echo;; esac | cat; @CP'],
  ['|| y && después de esac', 'case a in a) echo;; esac || true && @CP'],
  ['sustitución anidada en el patrón', 'case a in $(echo a)) echo;; esac; @CP'],
];

// Envolturas: `@` es el texto PREFIJO+CUERPO. `err: true` = la envoltura produce nodos ERROR.
// `sem` = equivalente inocuo para la validación semántica (sin escrituras), o null para no ejecutarla.
export const CONTEXTS = [
  ['$() entre comillas dobles', (s) => `echo "$(${s})"`, (s) => `echo "$(${s})"`],
  ['asignación x="$()"', (s) => `x="$(${s})"`, (s) => `x="$(${s})"; echo "$x"`],
  ['<()', (s) => `cat <(${s})`, (s) => `cat <(${s})`],
  ['>()', (s) => `tee >(${s}) </dev/null`, (s) => `echo >(${s}); wait`],
  ['${x:-$()}', (s) => `echo \${x:-$(${s})}`, (s) => `echo \${x:-$(${s})}`],
  ['diff <(echo a) <()', (s) => `diff <(echo a) <(${s})`, null],
  ['heredoc sin comillas', (s) => `cat <<E\n$(${s})\nE`, (s) => `cat <<E\n$(${s})\nE`],
  ['bloque con ERROR', (s) => `{ cat <<'X' 1<>out.txt; echo "$(${s})"; }`, null],
  ['subshell', (s) => `( echo "$(${s})" )`, (s) => `( echo "$(${s})" )`],
  ['$() anidado', (s) => `echo "$(echo $(${s}))"`, (s) => `echo "$(echo $(${s}))"`],
  ['saltos y tabs alrededor', (s) => `echo "$(\n\t${s}\n)"`, (s) => `echo "$(\n\t${s}\n)"`],
  ['comillas simples vecinas', (s) => `echo ')' "$(${s})" ')('`, (s) => `echo ')' "$(${s})" ')('`],
  ['comandos antes y después', (s) => `echo a; cat <(${s}) | cat; echo c`, (s) => `echo a; cat <(${s}) | cat; echo c`],
];

/** Destinos (texto que se espera en el cp de la IR, regla, palabra escrita en el comando). */
export function targets(froot) {
  return [
    ['CLAUDE.md', 'H-12', 'CLAUDE.md'],
    ['.claude/settings.json', 'H-12', '.claude/settings.json'],
    ['.git/config', 'H-12', '.git/config'],
    ['docs/MODULO_02_HANDOFF.md', 'H-10', 'docs/MODULO_02_HANDOFF.md'],
    [`${froot}/CLAUDE.md`, 'H-12', `${froot}/CLAUDE.md`],
    ['.claude/settings.json', 'H-12', ".cla''ude/sett\"\"ings.json"],
    ['docs/MODULO_02_HANDOFF.md', 'H-10', 'do"cs/MODULO_"02_HANDOFF.md'],
  ];
}

/** Casos: [nombre, texto, destino esperado, regla, texto inocuo (o null)]. */
export function matrix(froot) {
  const T = targets(froot);
  const out = [];
  let k = 0;
  const add = (pn, pre, bn, body, cn, cf, sf, popt = {}, bopt = {}) => {
    const [t, rule, word] = T[k++ % T.length];
    const s = pre + body.replace('@CP', `cp out.txt ${word}`);
    const sem = sf && popt.sem !== false && bopt.sem !== false ? sf(pre + body.replace('@CP', 'echo LEAK')) : null;
    out.push([`${pn} | ${bn} | ${cn}`, cf(s), t, rule, sem]);
  };
  // Prefijo × envoltura (cuerpo base) y prefijo × cuerpo (envoltura rotativa).
  for (const [pn, pre, popt] of PREFIXES) for (const [cn, cf, sf] of CONTEXTS) add(pn, pre, BODIES[0][0], BODIES[0][1], cn, cf, sf, popt);
  let j = 0;
  for (const [pn, pre, popt] of PREFIXES) {
    for (const [bn, body, bopt] of BODIES.slice(1)) {
      const [cn, cf, sf] = CONTEXTS[j++ % CONTEXTS.length];
      add(pn, pre, bn, body, cn, cf, sf, popt, bopt);
    }
  }
  return out;
}
