// Análisis de Bash con tree-sitter-bash (vendorizado). Produce una representación intermedia (IR)
// de comandos simples para que policy.mjs decida. tree-sitter-bash APROXIMA bash: no es bash.
// Por eso: todo nodo ERROR/MISSING se informa (hasError) y las palabras no literales quedan
// marcadas como dinámicas (text === null) para que la política las trate de forma conservadora.
import { pathToFileURL } from 'node:url';
import { vendorPath, verifyVendor } from './vendor.mjs';

let parserPromise = null;

async function getParser() {
  if (!parserPromise) {
    parserPromise = (async () => {
      verifyVendor();
      const mod = await import(pathToFileURL(vendorPath('web-tree-sitter/web-tree-sitter.js')).href);
      const { Parser, Language } = mod;
      await Parser.init({ locateFile: () => vendorPath('web-tree-sitter/web-tree-sitter.wasm') });
      const lang = await Language.load(vendorPath('tree-sitter-bash/tree-sitter-bash.wasm'));
      const p = new Parser();
      p.setLanguage(lang);
      return p;
    })();
  }
  return parserPromise;
}

const DYNAMIC_TYPES = new Set([
  'simple_expansion', 'expansion', 'command_substitution', 'process_substitution',
  'arithmetic_expansion', 'brace_expression', 'translated_string', 'ansi_c_string',
]);

// P0.3-B1.5.1: `\` + salto de línea es una continuación: Bash la elimina (no deja el salto), fuera
// de comillas y dentro de comillas dobles. Las comillas simples la conservan (raw_string).
function unescapeUnquoted(s) {
  return s.replace(/\\(.)/gs, (_, c) => (c === '\n' ? '' : c));
}

function unescapeDouble(s) {
  return s.replace(/\\([$`"\\\n])/g, (_, c) => (c === '\n' ? '' : c));
}

/**
 * P0.3-B1.2: comodín en un segmento SIN comillas. Se recorre el texto respetando los escapes
 * (`\*` es literal, pero en `\\*` la barra está escapada y el `*` sí expande).
 */
function unquotedGlob(raw) {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') { i++; continue; }
    if (raw[i] === '*' || raw[i] === '?' || raw[i] === '[') return true;
  }
  return false;
}

/** Convierte un nodo palabra en {text|null, raw, approx, quoted, glob}. */
export function wordInfo(node) {
  const raw = node.text;
  const t = node.type;
  if (t === 'word' || t === 'number') {
    return { text: unescapeUnquoted(raw), raw, approx: unescapeUnquoted(raw), quoted: false, glob: unquotedGlob(raw) };
  }
  if (t === 'raw_string') {
    const v = raw.slice(1, -1);
    return { text: v, raw, approx: v, quoted: true, glob: false };
  }
  if (t === 'string') {
    const inner = raw.slice(1, -1);
    const dyn = node.namedChildren.some((c) => c.type !== 'string_content');
    return { text: dyn ? null : unescapeDouble(inner), raw, approx: unescapeDouble(inner), quoted: true, glob: false };
  }
  if (t === 'concatenation') {
    const parts = node.namedChildren.map(wordInfo);
    const dyn = parts.some((p) => p.text === null);
    return {
      text: dyn ? null : parts.map((p) => p.text).join(''),
      raw,
      approx: parts.map((p) => p.approx).join(''),
      quoted: parts.some((p) => p.quoted),
      glob: parts.some((p) => p.glob),
    };
  }
  if (DYNAMIC_TYPES.has(t)) {
    return { text: null, raw, approx: raw.replace(/^["']|["']$/g, ''), quoted: false, glob: false };
  }
  // Cualquier otro tipo de nodo en posición de palabra: dinámico (conservador).
  return { text: null, raw, approx: raw, quoted: false, glob: false };
}

function ancestors(node) {
  const out = [];
  for (let p = node.parent; p; p = p.parent) out.push(p);
  return out;
}

function redirectInfo(r) {
  const out = { op: '', target: null, write: false, heredoc: null, herestring: null, id: r.id };
  // Descriptor explícito (3<, 3<<X): sólo fd 0 o ninguno es stdin.
  const fdN = r.namedChildren.find((c) => c.type === 'file_descriptor');
  out.fd = fdN ? fdN.text : null;
  const onStdin = out.fd === null || out.fd === '0';
  if (r.type === 'heredoc_redirect') {
    const body = r.namedChildren.find((c) => c.type === 'heredoc_body');
    out.op = '<<';
    out.heredoc = body ? body.text : '';
    out.heredocExpands = heredocExpands(body);
    out.stdin = onStdin;
    // tree-sitter anida dentro del heredoc las redirecciones escritas después de `<<X` en la misma
    // línea (`bash <<X < a.sh`). Se exponen para calcular el stdin efectivo.
    out.nested = r.namedChildren.filter((c) => c.type.endsWith('_redirect')).map(redirectInfo);
    out.nested.push(...wordReadWrites(r));
    return out;
  }
  if (r.type === 'herestring_redirect') {
    const w = r.namedChildren[r.namedChildren.length - 1];
    out.op = '<<<';
    out.herestring = w ? wordInfo(w) : null;
    out.stdin = onStdin;
    return out;
  }
  // file_redirect: [file_descriptor] operador destino
  const { op, opIds, lead, mixed } = redirectOperator(r);
  out.op = op;
  if (lead) {
    // `<>f` / `N<>f`: el '<' (y el número) quedaron antes del nodo; se recupera el descriptor.
    out.fd = lead.fd ? lead.fd.text : null;
  }
  const stdinFd = out.fd === null || out.fd === '0';
  const dest = r.childForFieldName('destination') || r.namedChildren.filter((c) => c.type !== 'file_descriptor').pop();
  if (mixed) out.target = mixedTarget(mixed);
  else if (dest) out.target = wordInfo(dest);
  // '>&' / '<&' hacia un descriptor numérico (2>&1) no es un archivo.
  const toFd = /&$/.test(out.op) && out.target && /^\d+$|^-$/.test(out.target.text ?? '');
  out.write = /[>]/.test(out.op) && !toFd;
  if (toFd) out.target = null;
  // Entrada estándar: '<' (archivo), '<>' (lectura-escritura) y '<&' (duplicar/cerrar un descriptor).
  out.stdin = stdinFd && /^<(>|&-?)?$/.test(out.op);
  // Redirección con un ERROR adentro (p. ej. `<<X > a | b`): el destino no es seguro. Cada palabra
  // es un destino posible y se revisa como tal. Un ERROR que sólo contiene parte del operador
  // (`1<>f` -> '<' + ERROR('>')) no es ambiguo: el destino es el de siempre.
  const ambiguous = r.namedChildren.some((c) => c.type === 'ERROR' && c.children.some((t) => !opIds.has(t.id)));
  // Con el destino recuperado del ERROR mixto, la palabra suelta del nodo es texto de la línea
  // siguiente (cuerpo del heredoc), no un destino: no se agregan alternativas.
  if (ambiguous && !mixed) {
    out.candidates = r.namedChildren.filter((c) => c.type !== 'file_descriptor' && c.type !== 'ERROR').map(wordInfo);
  }
  return out;
}

/**
 * Operador de un file_redirect sin depender de que tree-sitter lo entregue en un solo token.
 * tree-sitter-bash fragmenta `<>`: `1<>f` -> '<' + ERROR('>'); dentro de un bloque -> ERROR('<') + '>';
 * `<>f` y `0<>f` -> ERROR('<') como hermano anterior (y el número como palabra del comando) + '>'.
 * Se unen los tokens '<'/'>' contiguos (sin espacio entre ellos), incluidos los que están en un ERROR.
 * Devuelve {op, opIds, lead}; lead = {err, fd} cuando el '<' quedó antes del nodo.
 */
function redirectOperator(r) {
  const toks = [];
  for (const c of r.children) {
    if (!c.isNamed && /[<>]/.test(c.type)) toks.push(c);
    else if (c.type === 'ERROR' && c.children.length && c.children.every((t) => !t.isNamed && /^[<>]+$/.test(t.type))) toks.push(...c.children);
  }
  const run = [];
  for (const t of toks) {
    if (run.length && run[run.length - 1].endIndex !== t.startIndex) break;
    run.push(t);
  }
  let op = run.map((t) => t.type).join('');
  const opIds = new Set(run.map((t) => t.id));
  let lead = null;
  const err = fusedLeadingLt(r);
  if (err && run.length && op.startsWith('>') && !r.namedChildren.some((c) => c.type === 'file_descriptor')) {
    op = '<' + op;
    lead = { err, fd: fusedFdNumber(err) };
  }
  // P0.3-B1: en `{ cmd <<X N<>f; }` tree-sitter mete el '>' y el destino en un mismo ERROR
  // ('<' + ERROR('>', word "f; ", '}') + palabra de la línea siguiente). Sólo si el resultado es
  // exactamente '<>' se toma el '>' del ERROR y se devuelve ese ERROR para recuperar el destino.
  let mixed = null;
  const last = run[run.length - 1];
  if (op === '<' && last && last.parent && last.parent.id === r.id) {
    const nx = last.nextSibling;
    const head = nx && nx.type === 'ERROR' ? nx.children[0] : null;
    if (head && head.type === '>' && head.startIndex === last.endIndex && nx.children.length > 1) {
      op = '<>';
      opIds.add(head.id);
      mixed = { err: nx, after: head };
    }
  }
  return { op, opIds, lead, mixed };
}

const SAFE_TARGET = /^[A-Za-z0-9_./+,:=@%-]+$/;

/**
 * P0.3-B1: `{ cmd <<X 0<>f; }` no genera ningún file_redirect: dentro del heredoc queda
 * number('0') + ERROR(word "<>f; ", '}'). Una palabra sin comillas no puede empezar con '<' en
 * Bash, así que una palabra de un ERROR que empieza con '<>' es esa redirección. Se sintetiza
 * con el número pegado como descriptor y el destino cortado en el primer espacio o metacarácter.
 */
function wordReadWrites(r) {
  const out = [];
  for (const err of r.namedChildren) {
    if (err.type !== 'ERROR') continue;
    const w = err.children[0];
    if (!w || w.type !== 'word' || w.startIndex !== err.startIndex || !w.text.startsWith('<>')) continue;
    const prev = err.previousSibling;
    const fd = prev && prev.type === 'number' && prev.endIndex === err.startIndex && /^\d+$/.test(prev.text) ? prev.text : null;
    const cut = w.text.slice(2).split(/[\s;|&()<>]/)[0];
    const target = cut && SAFE_TARGET.test(cut)
      ? { text: cut, raw: cut, approx: cut, quoted: false, glob: false }
      : { text: null, raw: cut, approx: cut, quoted: false, glob: false };
    out.push({ op: '<>', target, write: true, heredoc: null, herestring: null, id: w.id, fd, stdin: fd === null || fd === '0' });
  }
  return out;
}

/** Destino de una palabra '<>…' suelta: el resto de la palabra o, si está vacía, el nodo pegado. */
function looseReadWriteTarget(w) {
  const dyn = (raw) => ({ text: null, raw, approx: raw, quoted: false, glob: false });
  const rest = w.text.slice(2);
  if (rest) {
    const cut = rest.split(/[\s;|&()<>]/)[0];
    return cut && SAFE_TARGET.test(cut) ? { text: cut, raw: cut, approx: cut, quoted: false, glob: false } : dyn(cut);
  }
  const holder = w.parent && w.parent.type === 'ERROR' && w.parent.endIndex === w.endIndex ? w.parent : w;
  const nx = holder.nextSibling;
  return nx && nx.isNamed && nx.startIndex === holder.endIndex ? wordInfo(nx) : dyn('');
}

/**
 * Destino de `<>` cuando quedó dentro del ERROR mixto. tree-sitter puede entregar una palabra que
 * arrastra texto posterior ("f; }", "f | grep a"): se corta en el primer espacio o metacarácter.
 * Si el destino no es un nombre literal simple (comillas, escapes, expansiones, globs, `~`, `{`)
 * o no hay destino claro, se devuelve un destino dinámico (text null): la política aplica H-12.
 */
function mixedTarget({ err, after }) {
  const kids = err.children;
  const i = kids.findIndex((c) => c.id === after.id);
  const node = kids[i + 1];
  if (!node || !node.isNamed) return { text: null, raw: '', approx: '', quoted: false, glob: false };
  const gap = err.text.slice(after.endIndex - err.startIndex, node.startIndex - err.startIndex);
  if (!/^[ \t]*$/.test(gap)) return { text: null, raw: node.text, approx: node.text, quoted: false, glob: false };
  if (node.type === 'word') {
    const cut = node.text.split(/[\s;|&()<>]/)[0];
    if (cut && SAFE_TARGET.test(cut)) return { text: cut, raw: cut, approx: cut, quoted: false, glob: false };
    return { text: null, raw: cut, approx: cut, quoted: false, glob: false };
  }
  // Nodos acotados (comillas, concatenación, expansión): wordInfo ya los resuelve o los marca dinámicos.
  if (['raw_string', 'string', 'concatenation', 'simple_expansion', 'expansion', 'command_substitution'].includes(node.type)) {
    return wordInfo(node);
  }
  return { text: null, raw: node.text, approx: node.text, quoted: false, glob: false };
}

/** ERROR('<') pegado inmediatamente antes del file_redirect (`<>f`, `0<>f`), o null. */
function fusedLeadingLt(r) {
  const prev = r.previousSibling;
  if (!prev || prev.type !== 'ERROR' || prev.endIndex !== r.startIndex) return null;
  return prev.children.length === 1 && prev.children[0].type === '<' ? prev : null;
}

/** Número pegado antes del '<' fragmentado (`0<>f`): tree-sitter lo dejó como última palabra del comando. */
function fusedFdNumber(err) {
  const cmd = err.previousSibling;
  if (!cmd || cmd.type !== 'command') return null;
  const last = cmd.namedChildren[cmd.namedChildren.length - 1];
  return last && last.type === 'number' && last.endIndex === err.startIndex && /^\d+$/.test(last.text) ? last : null;
}

/**
 * Lista plana de redirecciones de un comando: las de primer nivel más las que tree-sitter anida
 * dentro de un heredoc (`cat <<X > a`), sin repetir un mismo nodo (id). El heredoc pierde `nested`
 * en la copia plana para que stdin no cuente dos veces. Las redirecciones ambiguas agregan una
 * entrada por cada destino posible (sin stdin).
 */
function flattenRedirects(list) {
  const seen = new Set();
  const flat = [];
  const add = (r) => { if (!seen.has(r.id)) { seen.add(r.id); flat.push(r); } };
  for (const r of list) {
    add(r.nested ? { ...r, nested: undefined } : r);
    for (const n of r.nested ?? []) add(n);
  }
  for (const r of [...flat]) {
    for (const c of r.candidates ?? []) {
      if (c.raw !== r.target?.raw) flat.push({ ...r, target: c, stdin: false, candidates: undefined, alternative: true });
    }
  }
  return flat.map(globWriteDynamic);
}

/**
 * P0.3-B1.2: un destino de escritura con comodín sin comillas (`> C''LAUDE.m?`, `> "docs"/X?.md`)
 * lo resuelve Bash contra el sistema de archivos al ejecutar: el texto literal con '?' no es el
 * archivo que se escribe. No se expande acá: el destino pasa a dinámico y la política aplica H-12.
 * `glob` sólo se activa por caracteres fuera de comillas, por segmento (wordInfo / lexWord).
 */
function globWriteDynamic(r) {
  return r.write && r.target && r.target.glob && r.target.text !== null ? { ...r, target: { ...r.target, text: null } } : r;
}

/** Redirecciones que leen fd 0, incluidas las que tree-sitter anida dentro de un heredoc. */
function stdinRedirects(redirects) {
  return redirects.flatMap((r) => [r, ...(r.nested ?? [])]).filter((r) => r.stdin);
}

/**
 * stdin efectivo según las redirecciones propias del comando, que en Bash prevalecen sobre el
 * pipe. undefined: no hay redirección de entrada propia (vale el pipe o el heredoc del pipeline).
 * Más de una, o una duplicación de descriptor (<&): no se resuelve con certeza -> dynamic.
 */
function ownStdin(redirects, node) {
  const ins = stdinRedirects(redirects);
  if (!ins.length) return undefined;
  if (ins.length > 1) return { kind: 'dynamic', text: node.text, via: 'redirecciones de entrada múltiples' };
  const r = ins[0];
  if (r.heredoc !== null) return { kind: 'literal', text: r.heredoc, expands: r.heredocExpands };
  if (r.herestring) return r.herestring.text === null ? { kind: 'dynamic', text: r.herestring.approx } : { kind: 'literal', text: r.herestring.text };
  if (r.op === '<' || r.op === '<>') return r.target ? { kind: 'file', text: '', target: r.target } : { kind: 'dynamic', text: node.text, via: 'redirección de entrada sin destino' };
  return { kind: 'dynamic', text: node.text, via: 'duplicación de descriptor de entrada' };
}

function firstCommandOf(node) {
  if (!node) return null;
  if (node.type === 'command') return node;
  return node.descendantsOfType ? node.descendantsOfType('command')[0] ?? null : null;
}

/**
 * Un heredoc con delimitador sin comillas se expande antes de llegar a stdin: tree-sitter marca
 * esas expansiones como hijos del cuerpo. Con delimitador entre comillas el cuerpo es texto plano.
 */
function heredocExpands(body) {
  return !!body && body.namedChildren.some((c) => DYNAMIC_TYPES.has(c.type));
}

function commandWords(cmd) {
  const ws = cmd.namedChildren.filter((c) => c.type !== 'variable_assignment' && !c.type.endsWith('_redirect'));
  const name = ws[0] ? wordInfo(ws[0].type === 'command_name' ? ws[0].namedChildren[0] ?? ws[0] : ws[0]) : null;
  return { name, args: ws.slice(1).map(wordInfo) };
}

/**
 * tree-sitter-bash ubica lo que sigue a `<<X` en la misma línea DENTRO del heredoc_redirect:
 *   redirected_statement(cat, heredoc_redirect(<<, X, pipeline("|", <receptor>), cuerpo, fin))
 * Si cmdNode es el primer comando de ese receptor (directo, dentro de un pipeline/lista anidado
 * por la izquierda, o en cualquier posición de un subshell o bloque { }), devuelve el
 * heredoc_redirect cuya salida (la del comando dueño) recibe por stdin. Si no, null.
 */
function heredocFeeder(cmdNode) {
  let cur = cmdNode;
  for (let p = cur.parent; p; cur = p, p = p.parent) {
    if (p.type === 'pipeline' && p.parent && p.parent.type === 'heredoc_redirect') {
      return p.namedChildren[0]?.id === cur.id ? p.parent : null;
    }
    if (p.type === 'subshell' || p.type === 'compound_statement') continue; // comparten stdin
    if (['pipeline', 'list', 'redirected_statement'].includes(p.type)) {
      if (p.namedChildren[0]?.id !== cur.id) return null;
      continue;
    }
    return null;
  }
  return null;
}

/** Lo que el comando dueño del heredoc escribe en el pipe hacia el receptor. */
function heredocOutput(hr) {
  const body = hr.namedChildren.find((c) => c.type === 'heredoc_body');
  const bodyText = body ? body.text : '';
  const rs = hr.parent;
  const dyn = { kind: 'dynamic', text: `${rs ? rs.text : hr.text}`, via: 'heredoc-pipe' };
  if (!rs || rs.type !== 'redirected_statement') return dyn;
  const ownerNode = rs.namedChildren[0];
  const owner = ownerNode?.type === 'command' ? ownerNode
    : ownerNode?.type === 'pipeline' ? ownerNode.namedChildren[ownerNode.namedChildren.length - 1] : null;
  if (!owner || owner.type !== 'command') return dyn;
  if (rs.namedChildren.filter((c) => c.type === 'heredoc_redirect').length !== 1) return dyn;
  // El heredoc debe ser la única entrada estándar del dueño (no `cat 3<<X`, no `cat < f <<X`).
  const ownerIns = stdinRedirects([...owner.namedChildren, ...rs.namedChildren]
    .filter((c) => c.type.endsWith('_redirect')).map(redirectInfo));
  if (ownerIns.length !== 1 || ownerIns[0].heredoc === null) return dyn;
  const { name, args } = commandWords(owner);
  if (!name || name.text === null) return dyn;
  // cat sin archivos (o con "-") copia el heredoc tal cual.
  if (name.text === 'cat' && args.every((a) => a.text === '-')) {
    return { kind: 'literal', text: bodyText, expands: heredocExpands(body), via: 'heredoc-pipe' };
  }
  // echo/printf ignoran stdin: emiten sus argumentos.
  if ((name.text === 'echo' || name.text === 'printf') && args.every((a) => a.text !== null)) {
    return { kind: 'literal', text: args.filter((a) => !/^-[neE]+$/.test(a.text)).map((a) => a.text).join(' '), via: 'heredoc-pipe' };
  }
  return { ...dyn, text: `${owner.text}\n${bodyText}` };
}

/** Texto de stdin si el comando anterior del pipeline es echo/printf con argumentos literales. */
function pipeStdin(cmdNode) {
  let el = cmdNode;
  if (el.parent && el.parent.type === 'redirected_statement') el = el.parent;
  const pl = el.parent;
  if (!pl || pl.type !== 'pipeline') return { kind: 'none', text: '' };
  const kids = pl.namedChildren;
  const i = kids.findIndex((k) => k.id === el.id);
  if (i <= 0) return { kind: 'none', text: '' };
  const prev = firstCommandOf(kids[i - 1]);
  if (!prev || kids[i - 1].type !== 'command') return { kind: 'dynamic', text: kids[i - 1].text };
  const ws = prev.namedChildren.filter((c) => c.type !== 'variable_assignment' && !c.type.endsWith('_redirect'));
  const name = ws[0] ? wordInfo(ws[0].type === 'command_name' ? ws[0].namedChildren[0] ?? ws[0] : ws[0]) : null;
  const args = ws.slice(1).map(wordInfo);
  if (name && (name.text === 'echo' || name.text === 'printf') && args.every((a) => a.text !== null)) {
    return { kind: 'literal', text: args.filter((a) => !/^-[neE]+$/.test(a.text)).map((a) => a.text).join(' ') };
  }
  return { kind: 'dynamic', text: kids[i - 1].text };
}

function buildCommand(node) {
  const words = [];
  const assigns = [];
  const redirects = [];
  // `0<>f`: tree-sitter deja el descriptor como última palabra del comando; no es un argumento.
  const nx = node.nextSibling;
  const fusedRedir = nx && nx.type === 'ERROR' ? nx.nextSibling : null;
  const fdWord = fusedRedir && fusedRedir.type === 'file_redirect' && fusedLeadingLt(fusedRedir)?.id === nx.id ? fusedFdNumber(nx) : null;
  for (const c of node.namedChildren) {
    if (fdWord && c.id === fdWord.id) continue;
    if (c.type === 'variable_assignment') {
      const nameN = c.childForFieldName('name');
      const valN = c.childForFieldName('value');
      assigns.push({ name: nameN ? nameN.text : c.text.split('=')[0], value: valN ? wordInfo(valN) : { text: '', raw: '', approx: '', quoted: false, glob: false } });
    } else if (c.type === 'command_name') {
      const inner = c.namedChildren[0] ?? c;
      words.push(wordInfo(inner));
    } else if (c.type.endsWith('_redirect')) {
      redirects.push(redirectInfo(c));
    } else {
      words.push(wordInfo(c));
    }
  }
  // Redirecciones del redirected_statement que envuelve al comando (o al pipeline cuyo último es él).
  let el = node;
  const p = node.parent;
  if (p && p.type === 'redirected_statement' && p.childForFieldName('body')?.id === node.id) el = p;
  if (el.type === 'redirected_statement') {
    for (const r of el.namedChildren) if (r.type.endsWith('_redirect')) redirects.push(redirectInfo(r));
  } else if (p && p.type === 'pipeline' && p.parent && p.parent.type === 'redirected_statement') {
    const kids = p.namedChildren;
    if (kids[kids.length - 1].id === node.id) {
      for (const r of p.parent.namedChildren) if (r.type.endsWith('_redirect')) redirects.push(redirectInfo(r));
    }
  }
  const anc = ancestors(node);
  let stdin = pipeStdin(node);
  if (stdin.kind === 'none') {
    const feeder = heredocFeeder(node);
    if (feeder) stdin = heredocOutput(feeder);
  }
  // Las redirecciones de entrada propias prevalecen sobre el pipe y sobre el heredoc del pipeline.
  const own = ownStdin(redirects, node);
  if (own) stdin = own;
  return {
    shell: 'bash',
    words,
    assigns,
    redirects: flattenRedirects(redirects),
    inFunction: anc.some((a) => a.type === 'function_definition'),
    stdin,
    source: node.text,
  };
}

// ---------------- P0.3-B1.1: lectura léxica de respaldo ----------------
// Cuando el árbol tiene nodos ERROR, tree-sitter puede fragmentar operadores (`0>f` ->
// concatenation[number, ERROR('>'), word]) o tragarse el resto de la línea dentro de una palabra
// ("out.txt; cp a b; "). No se parchea cada forma: se relee el texto completo con un lector léxico
// de Bash (comillas, escapes, expansiones, heredocs, comentarios) que reconstruye TODAS las
// redirecciones y comandos simples. Lo que el AST no representó se agrega a la IR marcado
// `lexical: true`; lo que el lector no puede leer con certeza queda en `ambiguous` y se bloquea.
// No es un intérprete de Bash: es una segunda lectura conservadora para árboles con errores.

const LEX_REDIR = ['<<<', '<<-', '&>>', '<<', '<>', '<&', '>>', '>|', '>&', '&>', '<', '>'];
const LEX_CTRL = ['&&', '||', ';;&', ';;', ';&', '|&', ';', '|', '&', '(', ')'];
const LEX_RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'esac']);
const LEX_COMPOUND = new Set(['for', 'select', 'case', 'function', 'coproc']);
const LEX_OPS = [...LEX_REDIR, ...LEX_CTRL, '((', '<(', '>('];

/**
 * P0.3-B1.5.1: true si una continuación (`\`+LF) dentro de los próximos caracteres cambia el operador
 * que empieza en src[i]: Bash la elimina antes de leer operadores, así que `&\⏎&` es `&&` y `<\⏎<X`
 * un heredoc. Si el operador es el mismo con y sin la continuación (`&&\⏎`, `|\⏎ cmd`), no importa.
 */
function lexOpSplit(src, i) {
  let logical = '';
  let split = false;
  for (let j = i; j < src.length && logical.length < 3;) {
    const c = lexContAt(src, j);
    if (c) { split = true; j += c; continue; }
    logical += src[j++];
  }
  if (!split) return false;
  const longest = (s) => LEX_OPS.reduce((a, o) => (s.startsWith(o) && o.length > a.length ? o : a), '');
  return longest(logical) !== longest(src.slice(i, i + 3));
}

/** Índice después del cierre balanceado que abre en src[i] (`(` o `{`), respetando comillas. -1 si no cierra. */
function lexSkipBalanced(src, i, open, close) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j++; continue; }
    if (ch === "'") { const k = src.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue; }
    if (ch === '"') { const r = lexDouble(src, j); if (r.bad) return -1; j = r.e - 1; continue; }
    if (ch === '`') { const k = lexSkipBacktick(src, j); if (k < 0) return -1; j = k - 1; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return j + 1;
  }
  return -1;
}

function lexSkipBacktick(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '`') return j + 1;
  }
  return -1;
}

// ---- P0.3-B1.2: contenido ejecutable de las sustituciones ----
// `…`, $(…), <(…) y >(…) ejecutan comandos. El lector ya no las salta como texto opaco: registra
// su cuerpo como una sustitución ({kind, body, off|map}) y lexBash lo relee recursivamente con el
// mismo lector. Las posiciones se traducen al texto original (off = desplazamiento; map = índice
// por carácter cuando Bash quita barras, como en las comillas invertidas) para deduplicar contra
// el AST. Lo que no se puede delimitar con certeza vuelve como {bad} y termina en H-13.

/** `…` en src[i]. Bash quita la barra ante $, ` y \ (y ante " dentro de comillas dobles). */
function lexBacktick(src, i, inDq) {
  const k = lexSkipBacktick(src, i);
  if (k < 0) return { bad: 'comilla invertida sin cerrar' };
  let body = '';
  const map = [];
  for (let j = i + 1; j < k - 1; j++) {
    const nx = src[j + 1];
    if (src[j] === '\\' && j + 1 < k - 1 && ('$`\\'.includes(nx) || (inDq && nx === '"'))) j++;
    body += src[j];
    map.push(j);
  }
  map.push(k - 1);
  return { k, subs: [{ kind: '``', body, map }] };
}

// ---- P0.3-B1.3: cierre de $(…), <(…) y >(…) ----
// Contar paréntesis carácter por carácter (lexSkipBalanced) cerraba antes de tiempo con un ')' en
// un comentario (`<(echo # )`), en un patrón de case (`<(case a in a) …;; esac)`) o en el cuerpo de
// un heredoc (`<(cat <<E\n)\nE\n…)`), y lo que seguía quedaba fuera del análisis. El cierre se
// busca ahora con el mismo tokenizador léxico (lexTokens en modo untilClose): comillas, escapes,
// comentarios sólo al inicio de palabra, cuerpos de heredoc consumidos en cada salto de línea,
// sustituciones anidadas, subshells y patrones de case. Si no hay un cierre confiable -> {bad} -> H-13.

const LEX_MAX_NESTING = 32;
let lexNesting = 0;

/** Índice del ')' que cierra la sustitución cuyo cuerpo empieza en src[start], o {bad}. */
function lexCloseParen(src, start) {
  if (lexNesting >= LEX_MAX_NESTING) return { bad: 'sustituciones anidadas demasiado profundas' };
  lexNesting++;
  try {
    const r = lexTokens(src, { start, untilClose: true });
    if (r.ambiguous.length) return { bad: r.ambiguous[0].why };
    if (r.close < 0) return { bad: 'sin cerrar' };
    return { close: r.close };
  } finally {
    lexNesting--;
  }
}

/** $(…) o $((…)) en src[i]. $(( es aritmética sólo si el segundo '(' cierra justo antes del ')' final. */
function lexDollarParen(src, i) {
  if (src[i + 2] === '(') {
    const k = lexSkipBalanced(src, i + 1, '(', ')');
    if (k > 0 && lexSkipBalanced(src, i + 2, '(', ')') === k - 1) {
      const sc = lexScanSubs(src, i + 3, k - 2, false); // la aritmética puede contener $(…) y `…`
      return sc.bad ? sc : { k, subs: sc.subs };
    }
  }
  const c = lexCloseParen(src, i + 2);
  if (c.bad) return { bad: c.bad === 'sin cerrar' ? 'sustitución de comandos sin cerrar' : `sustitución de comandos: ${c.bad}` };
  return { k: c.close + 1, subs: [{ kind: '$()', body: src.slice(i + 2, c.close), off: i + 2 }] };
}

/** <(…) o >(…) en src[i]: no es una redirección; el cuerpo se ejecuta. */
function lexProcSub(src, i) {
  const c = lexCloseParen(src, i + 2);
  if (c.bad) return { bad: c.bad === 'sin cerrar' ? 'sustitución de proceso sin cerrar' : `sustitución de proceso: ${c.bad}` };
  return { k: c.close + 1, subs: [{ kind: `${src[i]}()`, body: src.slice(i + 2, c.close), off: i + 2 }] };
}

/** ${…} en src[i]: su contenido (p. ej. ${x:-$(cmd)}) puede tener sustituciones. */
function lexBraceExp(src, i) {
  const k = lexSkipBalanced(src, i + 1, '{', '}');
  if (k < 0) return { bad: 'expansión sin cerrar' };
  const sc = lexScanSubs(src, i + 2, k - 1, true);
  return sc.bad ? sc : { k, subs: sc.subs };
}

/**
 * Sustituciones dentro de src[s, e) cuando ese texto se expande sin separarse en palabras: cuerpo
 * de heredoc sin comillas, aritmética, ${…}. Conservador: no distingue comillas internas, así que
 * puede releer de más (falso positivo) pero no de menos. proc: considerar también <( y >(.
 */
function lexScanSubs(src, s, e, proc) {
  const subs = [];
  for (let j = s; j < e; j++) {
    const ch = src[j];
    // P0.3-B1.5.1: `$\⏎(…)` es `$(…)` para Bash.
    if (ch === '$' && lexContAt(src, j + 1)) return { bad: 'continuación de línea después de $' };
    if (proc && (ch === '<' || ch === '>') && lexContAt(src, j + 1)) return { bad: 'continuación de línea dentro de un operador' };
    if (ch === '\\') { j++; continue; }
    let r = null;
    if (ch === '`') r = lexBacktick(src, j, false);
    else if (ch === '$' && src[j + 1] === '(') r = lexDollarParen(src, j);
    else if (proc && (ch === '<' || ch === '>') && src[j + 1] === '(') r = lexProcSub(src, j);
    if (!r) continue;
    if (r.bad || r.k > e) return { bad: r.bad ?? 'sustitución que excede su expansión' };
    subs.push(...r.subs);
    j = r.k - 1;
  }
  return { subs };
}

// ---- P0.3-B1.5.1: continuaciones de línea ----
// Bash elimina `\` + salto de línea antes de separar palabras y operadores (fuera de comillas
// simples, de $'…', de comentarios y de cuerpos de heredoc con delimitador entre comillas). El
// lector conserva el texto original (`raw`, posiciones) y compara palabras reservadas, prefijos,
// opciones, asignaciones y descriptores sobre la palabra lógica (`lit`/`lraw`), sin continuaciones.
// Una continuación que une un operador (`&\⏎&`, `<\⏎<`, `(\⏎(`) o que sigue a `$` (`$\⏎(…)`) no se
// reconstruye: queda ambigua (H-13). Con CRLF (`\`+CR+LF) Git Bash une las líneas y Bash en Linux
// no: las dos lecturas difieren y tampoco se elige ninguna.
const LEX_CRLF_CONT = 'continuación de línea con CRLF (Git Bash une las líneas; Bash en Linux no)';
/** Longitud de la continuación que empieza en src[i] (2 = `\`+LF, 3 = `\`+CR+LF) o 0. */
function lexContAt(src, i) {
  if (src[i] !== '\\') return 0;
  if (src[i + 1] === '\n') return 2;
  if (src[i + 1] === '\r' && src[i + 2] === '\n') return 3;
  return 0;
}

/** Cadena "..." que empieza en src[i]: {e, lit, dyn, subs} o {bad}. conts recibe las continuaciones. */
function lexDouble(src, i, conts) {
  let lit = '';
  let dyn = false;
  const subs = [];
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === '"') return { e: j + 1, lit, dyn, subs };
    if (ch === '$' && lexContAt(src, j + 1)) return { bad: 'continuación de línea después de $' };
    if (ch === '\\') {
      const nx = src[j + 1];
      if (lexContAt(src, j) === 3) return { bad: LEX_CRLF_CONT };
      if (nx === '\n') { conts?.push(j); j++; continue; }
      if (nx !== undefined && '$`"\\'.includes(nx)) { lit += nx; j++; continue; }
      lit += ch; continue;
    }
    let r = null;
    if (ch === '`') r = lexBacktick(src, j, true);
    else if (ch === '$' && src[j + 1] === '(') r = lexDollarParen(src, j);
    else if (ch === '$' && src[j + 1] === '{') r = lexBraceExp(src, j);
    if (r) {
      if (r.bad) return { bad: r.bad };
      subs.push(...r.subs);
      dyn = true; lit += src.slice(j, r.k); j = r.k - 1; continue;
    }
    if (ch === '$' && /[A-Za-z0-9_@*#?$!-]/.test(src[j + 1] ?? '')) dyn = true;
    lit += ch;
  }
  return { bad: 'comilla doble sin cerrar' };
}

/** Palabra que empieza en src[i]: {t:'word', s, e, raw, text|null, lit, quoted, glob, subs} o {bad}. */
function lexWord(src, i) {
  const s = i;
  const n = src.length;
  let lit = '';
  let dyn = false;
  let quoted = false;
  let glob = false;
  let brace = false;
  const subs = [];
  const conts = []; // P0.3-B1.5.1: posiciones de las continuaciones eliminadas (fuera de '…')
  while (i < n) {
    const ch = src[i];
    if ((ch === '<' || ch === '>') && src[i + 1] === '(' && i === s) {
      const r = lexProcSub(src, i);
      if (r.bad) return { bad: r.bad, s };
      subs.push(...r.subs);
      dyn = true; lit += src.slice(i, r.k); i = r.k; continue;
    }
    if (/[ \t\n;&|()<>]/.test(ch)) break;
    if (ch === '\\') {
      if (lexContAt(src, i) === 3) return { bad: LEX_CRLF_CONT, s };
      if (src[i + 1] === '\n') { conts.push(i); i += 2; continue; }
      if (i + 1 < n) lit += src[i + 1];
      quoted = true; i += 2; continue;
    }
    if (ch === "'") {
      const k = src.indexOf("'", i + 1);
      if (k < 0) return { bad: 'comilla simple sin cerrar', s };
      lit += src.slice(i + 1, k); quoted = true; i = k + 1; continue;
    }
    if (ch === '"') {
      const r = lexDouble(src, i, conts);
      if (r.bad) return { bad: r.bad, s };
      subs.push(...r.subs);
      lit += r.lit; dyn ||= r.dyn; quoted = true; i = r.e; continue;
    }
    if (ch === '`') {
      const r = lexBacktick(src, i, false);
      if (r.bad) return { bad: r.bad, s };
      subs.push(...r.subs);
      dyn = true; lit += src.slice(i, r.k); i = r.k; continue;
    }
    if (ch === '$') {
      const nx = src[i + 1] ?? '';
      // P0.3-B1.5.1: `$\⏎(…)`, `$\⏎{…}`, `$\⏎x`: Bash une y expande; no se reconstruye.
      if (lexContAt(src, i + 1)) return { bad: 'continuación de línea después de $', s };
      if (nx === "'") {
        let k = i + 2;
        while (k < n && src[k] !== "'") k += src[k] === '\\' ? 2 : 1;
        if (k >= n) return { bad: "cadena $'...' sin cerrar", s };
        dyn = true; lit += src.slice(i, k + 1); i = k + 1; continue;
      }
      if (nx === '"') {
        const r = lexDouble(src, i + 1, conts);
        if (r.bad) return { bad: r.bad, s };
        subs.push(...r.subs);
        dyn = true; lit += r.lit; i = r.e; continue;
      }
      if (nx === '(' || nx === '{') {
        const r = nx === '(' ? lexDollarParen(src, i) : lexBraceExp(src, i);
        if (r.bad) return { bad: r.bad, s };
        subs.push(...r.subs);
        dyn = true; lit += src.slice(i, r.k); i = r.k; continue;
      }
      if (/[A-Za-z0-9_@*#?$!-]/.test(nx)) {
        let k = i + 2;
        if (/[A-Za-z_]/.test(nx)) while (k < n && /\w/.test(src[k])) k++;
        dyn = true; lit += src.slice(i, k); i = k; continue;
      }
    }
    if (ch === '*' || ch === '?' || ch === '[') glob = true;
    if (ch === '{') brace = true;
    if (ch === '~' && i === s) dyn = true;
    lit += ch; i++;
  }
  const raw = src.slice(s, i);
  // P0.3-B1.5.1: lraw = texto original sin las continuaciones que Bash elimina (conserva comillas y
  // escapes). Para comparar formas sintácticas (asignación, descriptor, `{`); raw queda para posiciones,
  // diagnósticos y para la política (un nombre con continuación no es canónico: raw !== text).
  let lraw = raw;
  for (let k = conts.length - 1; k >= 0; k--) lraw = lraw.slice(0, conts[k] - s) + lraw.slice(conts[k] - s + 2);
  if (brace && lraw !== '{' && /,|\.\./.test(lraw)) dyn = true; // expansión de llaves
  return { t: 'word', s, e: i, raw, lraw, text: dyn ? null : lit, lit, quoted, glob, subs };
}

const lexInfo = (w) => ({ text: w.text, raw: w.raw, approx: w.lit, quoted: w.quoted, glob: w.glob });
/**
 * P0.3-B1.5.1: palabra lógica para reconocer palabras reservadas, prefijos y opciones: sólo una
 * palabra sin comillas, sin escapes y sin expansiones (para ellas lit === lraw). Una palabra citada o
 * escapada (`"time"`, `\time`, `ti''me`) nunca es reservada.
 */
const lexKw = (w) => (w && w.t === 'word' && !w.quoted && w.text !== null ? w.lit : null);

// Palabras reservadas después de las cuales empieza un comando (donde `case` y `esac` son reservadas).
// Sólo cuentan si ellas mismas están en posición de comando (`echo if case` no abre un case).
const LEX_CMD_PREFIX = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
// P0.3-B1.4: palabras que Bash reconoce como reservadas después de `coproc` y de `coproc NOMBRE`
// / `function NOMBRE` (reserved_word_acceptable). `time` no está: ahí es un nombre o un argumento.
const LEX_RESERVED_WORDS = new Set(['case', 'esac', 'if', 'then', 'else', 'elif', 'fi', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function', 'coproc', '{', '}', '!', '[[', ']]']);
// P0.3-B1.4: con modo POSIX, `time` seguido de una palabra que empieza con '-' no es reservada
// (Bash interp. 267). El modo puede activarse dentro del propio comando; si el texto lo menciona,
// `time -…` tiene dos lecturas posibles y no se elige ninguna.
let lexPosixHint = false;
// P0.3-B1.5: palabras reservadas que abren y cierran un compuesto (para delimitar el comando de un
// coproc). `(`/`)` se cuentan aparte, como operadores.
const LEX_OPENERS = new Set(['{', 'if', 'while', 'until', 'for', 'select', 'case']);
const LEX_CLOSERS = new Set(['}', 'fi', 'done', 'esac']);

/**
 * Tokens de src: palabras, redirecciones (con delimitador y cuerpo de heredoc) y operadores de control.
 * P0.3-B1.3: opts.untilClose lee desde opts.start hasta el ')' que no abre ningún '(' del propio
 * texto ni cierra un patrón de case, y lo devuelve en `close` (-1 si no aparece). Se usa para
 * delimitar $(…), <(…) y >(…). Un ')' con un heredoc todavía sin cuerpo, o con un case abierto, no es
 * un cierre confiable: queda ambiguo.
 */
function lexTokens(src, opts = {}) {
  const untilClose = !!opts.untilClose;
  const toks = [];
  const ambiguous = [];
  const pending = [];
  const subs = []; // P0.3-B1.2: sustituciones de todas las palabras, incluidas las de [[ ]] y for/case
  const n = src.length;
  let i = opts.start ?? 0;
  let close = -1;
  // P0.3-B1.3: paréntesis de subshell abiertos y cases abiertos ({st, words, lead, pd}).
  // st: 'subject' (espera la palabra), 'in', 'pat' (patrones hasta ')'), 'body' (comandos hasta ;;).
  let depth = 0;
  let cmdStart = true;
  // P0.3-B1.4: `time` sólo es reservada al inicio de un pipeline: no después de '|', '|&' (ni de
  // '|' + salto de línea), de `coproc` ni de `coproc/function NOMBRE` (time_command_acceptable).
  let timeOk = true;
  let pipeCtx = false;
  // P0.3-B1.4: prefijo en curso: {k:'time', p, dd} | {k:'coproc', kw} | {k:'coproc-name', kw, name} |
  // {k:'function', kw}. Las palabras del prefijo (opciones de time, `coproc NOMBRE`, `function
  // NOMBRE`) se marcan `prefix` para que lexBash no las tome como el programa.
  let pre = null;
  const cases = [];
  // P0.3-B1.5: anidamiento de compuestos abiertos en posición de comando ({, if, while, until, for,
  // select, case) y región de un `coproc`: desde la palabra que sigue a `coproc` hasta el operador
  // de control que termina su comando (simple o compuesto) en el mismo nivel. Las palabras de la
  // región se marcan `coproc`: su stdin es el pipe que el shell le escribe (`>&${COPROC[1]}`).
  let nest = 0;
  let region = null;
  // P0.3-B1.5: la palabra que sigue a una redirección es su destino; después de una redirección Bash
  // ya no reconoce palabras reservadas (`coproc 2>&1 { …; }` es un error de sintaxis).
  let redirNext = false;
  /** Actualiza el estado de case; devuelve true si la palabra es parte de un patrón (no un comando). */
  const caseWord = (w) => {
    // P0.3-B1.5.1: palabra lógica (sin continuaciones), no raw: `ti\⏎me` es `time` y `the\⏎n` es `then`.
    const kw = lexKw(w);
    const top = cases[cases.length - 1];
    pipeCtx = false;
    // Sujeto (`case PALABRA`), `in` y patrones no son comandos aunque estén en otra línea.
    const pattern = !!top && (top.st === 'subject' || top.st === 'in' || (top.st === 'pat' && !(kw === 'esac' && !top.words)));
    if (pattern || (top && top.st === 'pat')) {
      if (top.st === 'subject') top.st = 'in';
      else if (top.st === 'in') { if (kw === 'in') top.st = 'pat'; }
      else if (kw === 'esac' && !top.words) { cases.pop(); nest--; }
      else top.words++;
      cmdStart = false; timeOk = false; pre = null; redirNext = false;
      return pattern;
    }
    if (redirNext) { redirNext = false; pre = null; cmdStart = false; timeOk = false; return false; }
    let start = cmdStart;
    let tOk = timeOk && cmdStart;
    const p = pre;
    pre = null;
    if (p && p.k === 'time') {
      // `time -p`, `time --`, `time -p --`: opciones del reservado, no el comando. Bash 5.2 acepta
      // a veces un segundo `--` y a veces lo ejecuta como comando según el contexto: ambiguo.
      if (lexPosixHint && !p.p && !p.dd && w.lraw.startsWith('-')) ambiguous.push({ s: w.s, why: '`time` con opciones y modo POSIX posible' });
      if (kw === '-p' && !p.p && !p.dd) { w.prefix = true; pre = { k: 'time', p: true, dd: false }; cmdStart = true; timeOk = true; return false; }
      if (kw === '--' && !p.dd) { w.prefix = true; pre = { k: 'time', p: p.p, dd: true }; cmdStart = true; timeOk = true; return false; }
      if (kw === '--') ambiguous.push({ s: w.s, why: '`time` con `--` repetido' });
      // P0.3-B1.5.1: el lector reconoció `time [-p] [--]` delante de esta palabra (ver dedup en parseBash).
      w.timed = true;
    } else if (p && p.k === 'coproc') {
      // `coproc case …` / `coproc { …`: compuesto sin nombre. Cualquier otra palabra que no sea una
      // asignación es el NOMBRE (si sigue un compuesto) o el comando simple; `time` también.
      if (kw !== null && kw !== 'time' && LEX_RESERVED_WORDS.has(kw)) { p.kw.prefix = true; tOk = false; }
      else {
        if (!/^[A-Za-z_]\w*\+?=/.test(w.lraw)) pre = { k: 'coproc-name', kw: p.kw, name: w };
        cmdStart = false; timeOk = false; return false;
      }
    } else if (p && p.k === 'coproc-name') {
      // `coproc NOMBRE case …`: reservada (sin `time`); si no, NOMBRE es el comando y esto un argumento.
      if (kw !== null && LEX_RESERVED_WORDS.has(kw)) { p.kw.prefix = true; p.name.prefix = true; start = true; tOk = false; }
      else start = false;
    } else if (p && p.k === 'function') {
      // `function NOMBRE`: el nombre (con o sin comillas) no es un comando; después pueden venir
      // `()`, saltos de línea y el cuerpo compuesto, con sus palabras reservadas.
      w.prefix = true; p.kw.prefix = true; cmdStart = true; timeOk = false; return false;
    }
    if (start && kw !== null && LEX_OPENERS.has(kw)) nest++;
    else if (start && kw !== null && LEX_CLOSERS.has(kw) && !(kw === 'esac' && !(top && top.st === 'body'))) nest--;
    if (start && kw === 'case') cases.push({ st: 'subject', words: 0, lead: false, pd: 0 });
    else if (start && kw === 'esac' && top && top.st === 'body') cases.pop();
    else if (start && tOk && kw === 'time') { pre = { k: 'time', p: false, dd: false }; cmdStart = true; timeOk = true; return false; }
    else if (start && kw === 'coproc') {
      // P0.3-B1.5: `coproc` nunca es el programa: lo es la palabra siguiente (comando simple) o el
      // compuesto que sigue, con o sin NOMBRE.
      w.prefix = true;
      if (!region) region = { L: nest + depth };
      pre = { k: 'coproc', kw: w }; cmdStart = true; timeOk = false; return false;
    }
    else if (start && kw === 'function') { pre = { k: 'function', kw: w }; cmdStart = false; timeOk = false; return false; }
    cmdStart = start && kw !== null && LEX_CMD_PREFIX.has(kw);
    timeOk = cmdStart;
    return false;
  };
  /** Procesa un operador de control; devuelve true si es el cierre buscado (untilClose). */
  const caseOp = (v) => {
    const top = cases[cases.length - 1];
    // P0.3-B1.5: `coproc NOMBRE ( … )`: NOMBRE es el nombre del coproc, no un comando.
    if (pre && pre.k === 'coproc-name' && v === '(') pre.name.prefix = true;
    pre = null;
    redirNext = false;
    // P0.3-B1.5: el comando del coproc termina en el primer operador de control de su mismo nivel
    // (en un pipeline, `coproc a | b`, b ya no es parte del coproc).
    if (region && v !== '(' && v !== ')' && !(top && top.st === 'pat') && nest + depth <= region.L) region = null;
    if (top && top.st === 'pat') {
      // `(a)` admite un '(' inicial opcional; otros '(' del patrón (extglob) se cierran dentro de él.
      if (v === '(') { if (!top.words && !top.lead) top.lead = true; else top.pd++; return false; }
      if (v === ')') {
        if (top.pd) { top.pd--; return false; }
        top.st = 'body'; top.words = 0; top.lead = false; cmdStart = true; timeOk = true; pipeCtx = false; return false;
      }
      if (v === '|' || v === '\n') return false;
    }
    if (top && top.st === 'body' && (v === ';;' || v === ';&' || v === ';;&')) { top.st = 'pat'; top.words = 0; cmdStart = false; timeOk = false; return false; }
    cmdStart = true;
    pipeCtx = v === '|' || v === '|&' || (v === '\n' && pipeCtx);
    timeOk = !pipeCtx;
    if (v === '(') depth++;
    else if (v === ')') {
      if (depth === 0) return untilClose;
      depth--;
      if (region && nest + depth < region.L) region = null;
    }
    return false;
  };
  // Las sustituciones de un patrón también se recolectan (`case x in $(cmd))` las ejecuta).
  const pushWord = (w) => {
    if (region) w.coproc = true;
    if (caseWord(w)) w.casePattern = true;
    toks.push(w); subs.push(...(w.subs ?? []));
  };
  const bodies = (j) => {
    for (const p of pending) {
      const lines = [];
      const b0 = j;
      let b1 = j;
      while (j < n) {
        // P0.3-B1.5.1: con delimitador sin comillas, Bash une las líneas terminadas en `\` (impar:
        // `\\` es una barra escapada) ANTES de compararlas con el delimitador: `X\⏎` + línea vacía
        // es `X` y cierra el cuerpo. Con comillas el cuerpo es literal y no se une nada.
        let logical = '';
        const group = [];
        for (;;) {
          const nl = src.indexOf('\n', j);
          const end = nl < 0 ? n : nl;
          const line = src.slice(j, end);
          j = nl < 0 ? n : nl + 1;
          group.push(line + '\n');
          const m = !p.quoted && nl >= 0 && j < n ? /(\\+)(\r?)$/.exec(line) : null;
          if (m && m[1].length % 2 === 1) {
            if (m[2]) ambiguous.push({ s: end - 2, why: `cuerpo de heredoc: ${LEX_CRLF_CONT}` });
            logical += line.slice(0, line.length - 1 - m[2].length);
            continue;
          }
          logical += line;
          break;
        }
        if ((p.strip ? logical.replace(/^\t+/, '') : logical) === p.delim) { p.closed = true; break; }
        lines.push(...group);
        b1 = j;
      }
      p.tok.body = lines.join('');
      // Delimitador sin comillas: el cuerpo se expande, y sus $(…) y `…` se ejecutan.
      if (!p.quoted) {
        const sc = lexScanSubs(src, b0, Math.min(b1, n), false);
        if (sc.bad) ambiguous.push({ s: b0, why: `cuerpo de heredoc: ${sc.bad}` });
        else subs.push(...sc.subs);
      }
    }
    pending.length = 0;
    return j;
  };
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (lexContAt(src, i) === 3) { ambiguous.push({ s: i, why: LEX_CRLF_CONT }); break; }
    // P0.3-B1.5.1: un operador partido por una continuación (`&\⏎&`, `>\⏎>`, `<\⏎<`, `;\⏎;`,
    // `(\⏎(`, `<\⏎(`) es un solo operador para Bash. No se reconstruye: ambiguo.
    if ('<>&|;('.includes(ch) && lexOpSplit(src, i)) { ambiguous.push({ s: i, why: 'continuación de línea dentro de un operador' }); break; }
    if (ch === '\n') { caseOp('\n'); toks.push({ t: 'op', v: '\n', s: i, e: i + 1 }); i++; if (pending.length) i = bodies(i); continue; }
    if (ch === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    // (( ... )) aritmético al inicio de un comando: no contiene redirecciones, pero sí puede
    // contener $(…) y `…`. Si el segundo '(' no cierra justo antes del ')' final no es aritmética
    // (`((a); (b))` son subshells) y se lee con los tokens comunes.
    if (src.startsWith('((', i) && (!toks.length || toks[toks.length - 1].t === 'op')) {
      const k = lexSkipBalanced(src, i, '(', ')');
      if (k < 0) { ambiguous.push({ s: i, why: 'expresión aritmética sin cerrar' }); break; }
      if (lexSkipBalanced(src, i + 1, '(', ')') === k - 1) {
        const sc = lexScanSubs(src, i + 2, k - 2, false);
        if (sc.bad) { ambiguous.push({ s: i, why: sc.bad }); break; }
        subs.push(...sc.subs);
        toks.push({ t: 'arith', s: i, e: k }); i = k; continue;
      }
    }
    if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
      const w = lexWord(src, i);
      if (w.bad) { ambiguous.push({ s: i, why: w.bad }); break; }
      pushWord(w); i = w.e; continue;
    }
    const r = LEX_REDIR.find((o) => src.startsWith(o, i));
    if (r) {
      const tok = { t: 'redir', v: r, s: i, e: i + r.length };
      toks.push(tok);
      i += r.length;
      if (r !== '<<' && r !== '<<-') redirNext = true;
      if (r === '<<' || r === '<<-') {
        // P0.3-B1.5.1: también hay continuaciones entre `<<` y el delimitador (`<< \⏎ X`).
        while (src[i] === ' ' || src[i] === '\t' || lexContAt(src, i) === 2) i += lexContAt(src, i) || 1;
        const d = lexWord(src, i);
        if (d.bad || d.e === i) { ambiguous.push({ s: tok.s, why: d.bad ?? 'heredoc sin delimitador' }); break; }
        tok.delim = d; i = d.e;
        // El delimitador no se expande (sus $(…) no se ejecutan); sólo importa si tiene comillas.
        pending.push({ delim: d.lit, strip: r === '<<-', tok, quoted: d.quoted });
      }
      continue;
    }
    const c = LEX_CTRL.find((o) => src.startsWith(o, i));
    if (c) {
      if (caseOp(c)) {
        close = i;
        // El cuerpo de un heredoc empieza después del próximo salto de línea: si la sustitución
        // cierra antes, Bash lo leería fuera de ella. Tampoco es confiable un case sin esac.
        if (pending.length) ambiguous.push({ s: i, why: 'heredoc sin cuerpo dentro de la sustitución' });
        else if (cases.length) ambiguous.push({ s: i, why: 'case sin esac dentro de la sustitución' });
        break;
      }
      toks.push({ t: 'op', v: c, s: i, e: i + c.length }); i += c.length; continue;
    }
    const w = lexWord(src, i);
    if (w.bad) { ambiguous.push({ s: w.s, why: w.bad }); break; }
    pushWord(w); i = w.e;
  }
  if (pending.length && !untilClose) bodies(n);
  return { toks, ambiguous, subs, close };
}

/**
 * Lectura léxica completa: {commands, redirects, ambiguous}. commands tiene la forma de la IR
 * (más `start`, posición del nombre del programa); redirects son todas las redirecciones a archivo
 * con `cmd` = índice del comando léxico al que pertenecen (o -1).
 */
const LEX_MAX_DEPTH = 8;

function lexBash(src, opts = {}) {
  // P0.3-B1.2: opts = {depth, pos, stdin, kind} para releer el cuerpo de una sustitución.
  // pos traduce una posición de src a la del texto original; stdin es el heredado (dinámico).
  const depth = opts.depth ?? 0;
  const pos = opts.pos ?? ((p) => p);
  const inherited = opts.stdin ?? { kind: 'none', text: '' };
  // P0.3-B1.4: vale para todo el texto, sustituciones incluidas. P0.3-B1.5.1: también partida por
  // continuaciones (`pos\⏎ix`).
  if (!depth) lexPosixHint = /posix/i.test(src.replace(/\\\r?\n/g, ''));
  const { toks, ambiguous, subs } = lexTokens(src);
  const commands = [];
  const redirects = [];
  let cur = null;
  let prevSource = null;
  let pipedIn = false;
  const open = () => ({ items: [], redirects: [], s: null, e: null, skip: false });
  const close = (op) => {
    if (cur && !cur.skip) {
      const words = [];
      const assigns = [];
      let nameStart = null;
      let timed = false;
      for (const w of cur.items) {
        // P0.3-B1.5.1: palabra lógica (`{\⏎`, `ti\⏎me` son `{` y `time`).
        if (!words.length && LEX_RESERVED.has(lexKw(w))) continue;
        // P0.3-B1.4: opciones de `time`, `coproc NOMBRE` y `function NOMBRE` delante del comando.
        if (!words.length && w.t === 'word' && w.prefix) continue;
        const m = !words.length && w.t === 'word' && /^([A-Za-z_]\w*)\+?=/.exec(w.lit);
        // P0.3-B1.5.1: `x\⏎=1` es una asignación (lraw, sin continuaciones); `"x"=1` no.
        if (m && /^[A-Za-z_]\w*\+?=/.test(w.lraw)) {
          assigns.push({ name: m[1], value: { text: w.text === null ? null : w.text.slice(m[0].length), raw: w.raw, approx: w.lit.slice(m[0].length), quoted: w.quoted, glob: false } });
          continue;
        }
        if (!words.length) { nameStart = w.s; timed = !!w.timed; }
        words.push(lexInfo(w));
      }
      const idx = commands.length;
      for (const r of cur.redirects) r.cmd = words.length ? idx : -1;
      if (words.length && !(words[0].text !== null && LEX_COMPOUND.has(words[0].text))) {
        const source = src.slice(cur.s, cur.e);
        const own = ownStdin(cur.redirects, { text: source });
        // P0.3-B1.5: dentro de un coproc (sin pipe propio) stdin es el pipe que escribe el shell.
        const inCoproc = cur.items.some((w) => w.coproc);
        const stdin = own ?? (pipedIn ? { kind: 'dynamic', text: prevSource ?? '', via: 'lectura léxica: pipe' }
          : inCoproc ? { kind: 'dynamic', text: source, via: 'lectura léxica: stdin de coproc (pipe del shell)' } : inherited);
        const c = { shell: 'bash', words, assigns, redirects: cur.redirects.filter((r) => r.target || r.heredoc !== null || r.herestring), inFunction: false, stdin, source, lexical: true, start: pos(nameStart) };
        if (inCoproc) c.coproc = true;
        if (timed) c.timed = true;
        if (depth) { c.subst = opts.kind; c.substDepth = depth; } // origen: tipo y nivel de sustitución
        commands.push(c);
      } else {
        for (const r of cur.redirects) r.cmd = -1;
      }
      prevSource = src.slice(cur.s ?? 0, cur.e ?? 0);
    }
    pipedIn = op === '|' || op === '|&';
    cur = open();
  };
  cur = open();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'op') {
      // f() { ...: definición de función, no un comando.
      if (t.v === '(' && toks[k + 1]?.t === 'op' && toks[k + 1].v === ')' && cur.items.length === 1 && !cur.redirects.length) {
        cur.skip = true; k++; close(';'); continue;
      }
      close(t.v);
      continue;
    }
    if (t.t === 'arith') continue;
    // P0.3-B1.3: palabra de un patrón de case (`a|b)`): no es un comando. Sus sustituciones ya se
    // recolectaron en lexTokens.
    if (t.t === 'word' && t.casePattern) continue;
    if (cur.s === null) cur.s = t.s;
    cur.e = t.e;
    // [[ ... ]]: '<' y '>' comparan; no hay redirecciones hasta ']]'.
    if (lexKw(t) === '[[' && !cur.items.some((w) => !LEX_RESERVED.has(lexKw(w)))) {
      while (k + 1 < toks.length && lexKw(toks[k + 1]) !== ']]') k++;
      k++;
      cur.skip = true;
      continue;
    }
    if (t.t === 'word') { cur.items.push(t); continue; }
    // Redirección: descriptor = número (o {var}) pegado inmediatamente antes.
    let fd = null;
    const prev = cur.items[cur.items.length - 1];
    if (prev && prev.e === t.s && !prev.quoted && /^\d+$|^\{[A-Za-z_]\w*\}$/.test(prev.lraw)) { fd = prev.lraw; cur.items.pop(); }
    const op = t.v === '<<-' ? '<<' : t.v;
    const rec = { op, fd, target: null, write: false, heredoc: null, herestring: null, id: `lex:${pos(t.s)}`, lexical: true, cmd: -1 };
    if (op === '<<') {
      rec.heredoc = t.body ?? '';
      rec.heredocExpands = !t.delim.quoted && /[$`]/.test(rec.heredoc);
    } else {
      const w = toks[k + 1];
      if (!w || w.t !== 'word') { ambiguous.push({ s: t.s, why: `redirección ${t.v} sin destino` }); continue; }
      k++;
      cur.e = w.e;
      if (op === '<<<') rec.herestring = lexInfo(w);
      else if ((op === '>&' || op === '<&') && /^(\d+-?|-)$/.test(w.text ?? '')) rec.target = null; // duplicar/cerrar fd
      else {
        rec.target = lexInfo(w);
        rec.write = /[>]/.test(op);
        // Destino de escritura con comodín: el archivo real no es verificable sin expandir -> dinámico.
        // P0.3-B1.2: `glob` ya viene sólo de los segmentos sin comillas (C''LAUDE.m? sigue siendo
        // un comodín); exigir además que la palabra no tenga comillas lo dejaba pasar.
        if (rec.write && w.glob) rec.target = { ...rec.target, text: null };
      }
    }
    rec.stdin = (fd === null || fd === '0') && /^(<|<>|<&|<<|<<<)$/.test(op);
    cur.redirects.push(rec);
    redirects.push(rec);
  }
  close(null);
  const outRedirects = redirects.filter((r) => r.target);
  const outAmbiguous = ambiguous.map((a) => ({ ...a, s: pos(a.s), text: src.slice(a.s, a.s + 80) }));
  // P0.3-B1.2: el cuerpo de cada sustitución se relee con el mismo lector. Sus comandos y
  // redirecciones se agregan como cualquier otro (con posiciones del texto original); su stdin es
  // el del shell que la ejecuta, que el lector no conoce: dinámico.
  for (const sb of subs) {
    const childPos = sb.map ? (p) => pos(sb.map[Math.min(p, sb.map.length - 1)]) : (p) => pos(sb.off + p);
    if (depth + 1 > LEX_MAX_DEPTH) {
      outAmbiguous.push({ s: childPos(0), why: 'sustituciones anidadas demasiado profundas', text: sb.body.slice(0, 80) });
      continue;
    }
    const child = lexBash(sb.body, {
      depth: depth + 1,
      pos: childPos,
      kind: sb.kind,
      stdin: { kind: 'dynamic', text: sb.body, via: `lectura léxica: stdin heredado por ${sb.kind}` },
    });
    const base = commands.length;
    commands.push(...child.commands);
    for (const r of child.redirects) { r.cmd = r.cmd >= 0 ? r.cmd + base : -1; outRedirects.push(r); }
    outAmbiguous.push(...child.ambiguous);
  }
  return { commands, redirects: outRedirects, ambiguous: outAmbiguous };
}

const lexSig = (words) => words.map((w) => (w.text === null ? `\u0000${w.raw}` : w.text)).join('\u0001');
// Misma redirección = mismo operador, descriptor, clase y destino. Si el AST perdió el descriptor
// o el operador (`0>>f` -> '>>' sin fd), la versión léxica se agrega igual como evidencia.
const lexKey = (r) => `${r.write ? 'w' : 'r'}|${r.op}|${r.fd ?? ''}|${r.target?.text ?? `\u0000${r.target?.raw ?? ''}`}`;

const LEX_CASE_WORD = /\bcase\b/;
const LEX_PREFIX_PROGRAMS = new Set(['time', 'coproc']);
const LEX_CONTINUATION = /\\\r?\n/;

function hasErrorNodes(root) {
  if (root.hasError) return true;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.isMissing || n.type === 'ERROR') return true;
    for (const c of n.children) stack.push(c);
  }
  return false;
}

/** Parsea texto Bash y devuelve {hasError, commands, declarations}. */
export async function parseBash(text) {
  const parser = await getParser();
  const tree = parser.parse(text);
  try {
    const root = tree.rootNode;
    const commands = root.descendantsOfType('command').map(buildCommand);
    // Asignaciones en declaraciones (export/local/declare) e independientes: sirven para H-06/H-11.
    const declarations = [];
    for (const d of root.descendantsOfType(['declaration_command', 'variable_assignment'])) {
      if (d.type === 'variable_assignment' && d.parent && d.parent.type === 'command') continue;
      declarations.push(d.text);
    }
    const hasError = hasErrorNodes(root);
    // Heredoc + nodos ERROR: tree-sitter no pudo ubicar el pipeline (p. ej. `cat <<X 2>/dev/null | bash`
    // deja al receptor como palabra suelta). La política decide de forma conservadora.
    const heredocError = hasError && root.descendantsOfType(['heredoc_redirect', 'heredoc_start', 'heredoc_body']).length > 0;
    // Redirecciones que no quedaron asociadas a ningún comando (p. ej. dentro de un ERROR en un
    // bloque `{ ...; }`): se exponen para que la política revise igual sus destinos.
    const covered = new Set(commands.flatMap((c) => c.redirects.map((r) => r.id)));
    const loose = root.descendantsOfType(['file_redirect', 'heredoc_redirect', 'herestring_redirect'])
      .filter((r) => !covered.has(r.id)).map(redirectInfo);
    const orphanRedirects = flattenRedirects(loose).filter((r) => !covered.has(r.id) && r.target);
    // P0.3-B1: '<>' que tree-sitter dejó como texto de una palabra dentro de un ERROR, sin nodo de
    // redirección (p. ej. concatenation[number '0', ERROR(word '<>'), $F]). Si no se recuperó ya,
    // se expone como escritura; el destino es literal sólo si es un nombre simple, si no, dinámico.
    const seen = new Set([...covered, ...orphanRedirects.map((r) => r.id)]);
    for (const w of root.descendantsOfType('word')) {
      if (seen.has(w.id) || !w.text.startsWith('<>') || !ancestors(w).some((a) => a.type === 'ERROR')) continue;
      // Descriptor: número pegado antes del ERROR que contiene la palabra (concatenation[number '0', ERROR]).
      const holder = w.parent && w.parent.type === 'ERROR' && w.parent.startIndex === w.startIndex ? w.parent : w;
      const pn = holder.previousSibling;
      const fd = pn && pn.type === 'number' && pn.endIndex === holder.startIndex && /^\d+$/.test(pn.text) ? pn.text : null;
      orphanRedirects.push({ op: '<>', target: looseReadWriteTarget(w), write: true, heredoc: null, herestring: null, id: w.id, fd, stdin: false });
    }
    // P0.3-B1.1: con nodos ERROR, segunda lectura léxica del texto completo. Se agrega todo lo que
    // el AST no representó igual; `recovered` deja constancia de lo agregado y de lo ambiguo.
    const recovered = { commands: [], redirects: [], ambiguous: [] };
    // P0.3-B1.4: tree-sitter-bash no conoce `time -p`/`time --`, `coproc [NOMBRE]` ni `function NOMBRE`
    // delante de `case`: toma `case` como un argumento y cierra la sustitución en el ')' del patrón,
    // sin nodos ERROR, y lo que sigue queda como texto. Si el texto contiene la palabra `case`, la
    // lectura léxica se hace también con un árbol sin errores.
    // P0.3-B1.5: tree-sitter-bash tampoco conoce `time` ni `coproc` como palabras reservadas: los toma
    // como nombre de programa y lo que sigue (`{`, `if`, `while`, el comando del coproc) como sus
    // argumentos, sin nodos ERROR. Si algún comando del AST se llama así, se relee también.
    const astCmds = root.descendantsOfType('command');
    const prefixed = commands.slice(0, astCmds.length).some((c) => c.words[0] && !c.words[0].quoted && LEX_PREFIX_PROGRAMS.has(c.words[0].raw));
    // P0.3-B1.5.1: tree-sitter-bash toma `\` + salto de línea como un espacio, también dentro de una
    // palabra (`ti\⏎me` -> `ti` `me`; Bash lee `time`), y el árbol no tiene errores. Con cualquier
    // continuación en el texto se relee también; las palabras léxicas la eliminan como Bash.
    const continued = LEX_CONTINUATION.test(text);
    if (hasError || prefixed || continued || LEX_CASE_WORD.test(text)) {
      const lex = lexBash(text);
      const astByStart = new Map();
      astCmds.forEach((node, i) => {
        const nm = node.namedChildren.find((c) => c.type === 'command_name');
        if (nm) astByStart.set(nm.startIndex, { sig: lexSig(commands[i].words), i });
        // P0.3-B1.5: `time [-p] [--] cmd` del AST es el mismo comando que `cmd` léxico: la política
        // desenvuelve `time` y sus opciones. (No vale para coproc: la política no lo desenvuelve.)
        const ws = commands[i].words;
        const parts = nm ? [nm, ...node.childrenForFieldName('argument')] : [];
        if (parts.length !== ws.length || !ws.length || ws[0].quoted || ws[0].raw !== 'time') return;
        let k = 1;
        if (ws[k] && !ws[k].quoted && ws[k].raw === '-p') k++;
        if (ws[k] && !ws[k].quoted && ws[k].raw === '--') k++;
        if (k < ws.length && !(ws[k].text ?? '').startsWith('-') && !astByStart.has(parts[k].startIndex)) {
          astByStart.set(parts[k].startIndex, { sig: lexSig(ws.slice(k)), i, alt: true });
        }
      });
      const added = new Set();
      lex.commands.forEach((c, i) => {
        const same = astByStart.get(c.start);
        // P0.3-B1.5.1: la clave alternativa (`time … cmd` del AST = `cmd` léxico) sólo vale si el lector
        // también reconoció `time` delante de ese comando. Si no (p. ej. `{\⏎` tomado por el AST como
        // argumento de `time`), el comando léxico se conserva aunque las palabras coincidan.
        if (same && same.sig === lexSig(c.words) && (!same.alt || c.timed)) {
          // El AST ya lo representa igual. Si el léxico sabe que corre en un coproc, el stdin del
          // AST (que no lo sabe) pasa a ser el pipe del coproc.
          const a = commands[same.i];
          if (c.coproc && (!a.stdin || a.stdin.kind === 'none')) { a.stdin = c.stdin; a.coproc = true; }
          return;
        }
        added.add(i);
        commands.push(c);
        recovered.commands.push(c);
      });
      const known = new Set([...commands.filter((c) => !c.lexical).flatMap((c) => c.redirects), ...orphanRedirects].filter((r) => r.target).map(lexKey));
      for (const r of lex.redirects) {
        if (added.has(r.cmd) || known.has(lexKey(r))) continue;
        known.add(lexKey(r));
        orphanRedirects.push(r);
        recovered.redirects.push(r);
      }
      // Lo que el lector léxico no puede leer: se expone como un programa no verificable (H-13).
      for (const a of lex.ambiguous) {
        const word = { text: null, raw: `<texto no interpretable: ${a.why}>`, approx: a.text, quoted: false, glob: false };
        const c = { shell: 'bash', words: [word], assigns: [], redirects: [], inFunction: false, stdin: { kind: 'none', text: '' }, source: a.text, lexical: true, ambiguous: true };
        commands.push(c);
        recovered.ambiguous.push(a);
      }
    }
    return { hasError, heredocError, commands, declarations, orphanRedirects, recovered };
  } finally {
    tree.delete();
  }
}
