// Rutas: normalización, archivos sensibles, rutas protegidas (autoprotección) y globs.
// Es la segunda capa detrás de las reglas Read/Edit de settings.json: nunca la única.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTECTED_DOCS as PROJECT_DOCS } from './project.mjs';

export const HOME = os.homedir();

// Documentos con skip-worktree (H-10), en lib/project.mjs. Rutas relativas a la raíz del proyecto.
export const PROTECTED_DOCS = PROJECT_DOCS;

// Autoprotección (H-12): los controles y la config de git que puede esconder alias (H-11).
export const PROTECTED_REL = [
  'CLAUDE.md',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks',
  '.claude/rules',
  '.git/config',
];

/** Normaliza a forma comparable: barras '/', unidad 'c:/', minúsculas (Windows no distingue). */
export function norm(p) {
  if (p == null) return '';
  let s = String(p).replace(/\\/g, '/');
  const m = s.match(/^\/([a-zA-Z])(\/|$)/); // /c/Users -> c:/Users (Git Bash)
  if (m) s = `${m[1]}:/${s.slice(3)}`;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1);
  return s.toLowerCase();
}

/** Expande prefijos de home literales o aproximados ($HOME, ~, %USERPROFILE%, $env:USERPROFILE). */
export function expandHome(p) {
  return String(p)
    .replace(/^~(?=$|[\\/])/, HOME)
    .replace(/^\$\{?HOME\}?(?=$|[\\/])/i, HOME)
    .replace(/^%USERPROFILE%(?=$|[\\/])/i, HOME)
    .replace(/^\$env:USERPROFILE(?=$|[\\/])/i, HOME)
    .replace(/^\$env:HOME(?=$|[\\/])/i, HOME);
}

/** Resuelve p contra cwd y devuelve la forma normalizada. */
export function resolveFrom(cwd, p) {
  const e = expandHome(p);
  const native = e.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  return norm(path.win32.resolve(cwd || process.cwd(), native));
}

export function isWithin(child, parent) {
  const c = norm(child), q = norm(parent);
  return c === q || c.startsWith(q.endsWith('/') ? q : q + '/');
}

/** a y b se solapan si uno es igual, ancestro o descendiente del otro. */
export function overlaps(a, b) {
  return isWithin(a, b) || isWithin(b, a);
}

/**
 * Clasifica una ruta (literal o aproximada) como sensible. Devuelve el motivo o null.
 * Se evalúa sobre la ruta cruda y sobre la resuelta, por eso toma ambas.
 */
export function sensitiveReason(raw, resolved) {
  for (const cand of [raw, resolved]) {
    if (!cand) continue;
    const segs = norm(expandHome(cand)).split('/').filter(Boolean);
    const base = segs[segs.length - 1] || '';
    if (base.startsWith('.env') && !base.endsWith('.example')) return '.env*';
    if (base.endsWith('.pem')) return '*.pem';
    if (base.endsWith('.key')) return '*.key';
    for (const ext of ['.p12', '.pfx', '.secret']) if (base.endsWith(ext)) return `*${ext}`;
    if (base === 'core.env') return 'core.env';
    // Directorios de secretos (cualquier `secrets/` o `credentials/`, como en .gitignore).
    for (const d of ['secrets', 'credentials']) if (segs.includes(d)) return `${d}/`;
    if (base === 'launch.json' && segs[segs.length - 2] === '.claude') return '.claude/launch.json';
    if (segs.includes('.ssh')) return '~/.ssh';
    if (segs.includes('.aws')) return '~/.aws';
  }
  return null;
}

export function protectedTargets(root) {
  return PROTECTED_REL.map((r) => resolveFrom(root, r));
}

/** Devuelve la ruta protegida que se solapa con `resolved`, o null. */
export function protectedHit(root, resolved) {
  if (!root || !resolved) return null;
  for (const t of protectedTargets(root)) if (overlaps(resolved, t)) return t;
  return null;
}

export function protectedDocHit(root, resolved) {
  if (!root || !resolved) return null;
  for (const d of PROTECTED_DOCS) {
    const t = resolveFrom(root, d);
    if (overlaps(resolved, t)) return d;
  }
  return null;
}

// ---------- globs (fnmatch) ----------
export function hasGlob(s) {
  return /[*?[]/.test(s);
}

/** fnmatch sobre un segmento o ruta. dot=false imita bash (no matchea el punto inicial). */
export function globToRegex(glob, { dot = true, nocase = true } = {}) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = glob.indexOf(']', i + 2);
      if (j < 0) { re += '\\['; continue; }
      let cls = glob.slice(i + 1, j);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += '[' + cls.replace(/\\/g, '\\\\') + ']';
      i = j;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  // Como bash: sin dotglob, el punto inicial sólo matchea si el patrón empieza con punto.
  const body = dot || glob.startsWith('.') ? re : `(?!\\.)${re}`;
  return new RegExp(`^${body}$`, nocase ? 'i' : '');
}

export function fnmatch(glob, name, opts) {
  return globToRegex(glob, opts).test(name);
}

// Nombres representativos de cada clase sensible, para globs sin archivos en disco.
const SENSITIVE_SAMPLES = ['.env', '.env.local', '.env.production', '.envrc', 'server.pem', 'private.key'];

/**
 * Un glob (token con * ? [) es peligroso si su último segmento puede matchear un nombre sensible,
 * o si al expandirlo en disco aparece un archivo sensible.
 */
export function globSensitive(cwd, token, { dot }) {
  const t = norm(expandHome(token));
  const segs = t.split('/');
  const last = segs[segs.length - 1];
  if (hasGlob(last)) {
    for (const s of SENSITIVE_SAMPLES) if (fnmatch(last, s, { dot })) return `glob ${token} -> ${s}`;
  }
  const hits = expandGlob(cwd, token, { dot, limit: 5000 });
  if (hits === null) return `glob ${token} sin expansión acotada`;
  for (const h of hits) { const r = sensitiveReason(h, h); if (r) return `glob ${token} -> ${r}`; }
  return null;
}

/** Expansión de glob acotada. Devuelve rutas normalizadas o null si se pasó del límite. */
export function expandGlob(cwd, token, { dot = true, limit = 5000 } = {}) {
  // Base: el prefijo sin comodines.
  const full = resolveFrom(cwd, token);
  const fullSegs = full.split('/');
  const baseIdx = fullSegs.findIndex((s) => hasGlob(s));
  if (baseIdx < 0) return fs.existsSync(full) ? [full] : [];
  const out = [];
  let count = 0;
  const walk = (dir, idx) => {
    if (count > limit) return;
    if (idx >= fullSegs.length) { out.push(norm(dir)); return; }
    const seg = fullSegs[idx];
    if (!hasGlob(seg)) { walk(dir + '/' + seg, idx + 1); return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++count > limit) return;
      if (seg === '**') {
        walk(dir, idx + 1);
        if (e.isDirectory()) walk(dir + '/' + e.name, idx);
        out.push(norm(dir + '/' + e.name));
      } else if (fnmatch(seg, e.name, { dot })) walk(dir + '/' + e.name, idx + 1);
    }
  };
  walk(fullSegs.slice(0, baseIdx).join('/') || '/', baseIdx);
  return count > limit ? null : out;
}

/**
 * Recorre `root` buscando archivos sensibles. Devuelve {files:[rel...], truncated:bool}.
 * Acotado por cantidad de entradas: si se pasa, truncated=true (el llamador decide conservador).
 */
export function findSensitiveUnder(root, limit = 20000) {
  const files = [];
  let count = 0;
  let truncated = false;
  const base = norm(root);
  const st = (() => { try { return fs.statSync(root); } catch { return null; } })();
  if (!st) return { files, truncated };
  if (!st.isDirectory()) {
    if (sensitiveReason(base, base)) files.push(path.posix.basename(base));
    return { files, truncated };
  }
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++count > limit) { truncated = true; return { files, truncated }; }
      const full = path.join(dir, e.name);
      const rel = norm(path.relative(root, full));
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        if (['secrets/', 'credentials/'].includes(sensitiveReason(rel, norm(full)))) { files.push(rel + '/'); continue; }
        stack.push(full);
      } else if (sensitiveReason(rel, norm(full))) files.push(rel);
    }
  }
  return { files, truncated };
}
