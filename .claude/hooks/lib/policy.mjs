// Política del CTO sobre la IR de bash.mjs / powershell.mjs. Devuelve hallazgos deny/ask.
// Ids de regla: H-01..H-13 (bloqueos duros), SEC (archivos sensibles), D-5/D-6/D-7/D-8.
// Criterio: lo que no se puede resolver estáticamente y toca algo sensible, se bloquea.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseBash } from './bash.mjs';
import { parsePowerShell } from './powershell.mjs';
import * as P from './paths.mjs';
import { DEPLOY_SCRIPTS, DATA_SCRIPTS as PROJECT_DATA_SCRIPTS } from './project.mjs';

export const MAX_DEPTH = 6;

// ---------------- vocabulario y tablas ----------------
// Rangos por código (no literales) para no incrustar caracteres invisibles en el fuente.
const SUSPICIOUS_RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x180e, 0x180e], [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x2069], [0x3000, 0x3000], [0xfeff, 0xfeff]];
const BS = String.fromCharCode(92);
const esc = (n) => `${BS}u${n.toString(16).padStart(4, '0')}`;
const SUSPICIOUS_CHARS = new RegExp('[' + SUSPICIOUS_RANGES.map(([a, b]) => `${esc(a)}-${esc(b)}`).join('') + ']');

export const SENSITIVE_VOCAB = new RegExp(
  [
    '\\b(git|docker|docker-compose|ssh|scp|sftp|rsync|alembic|claude|sudo|wsl|vercel|gh|tailscale|cloudflared)\\b',
    ...DEPLOY_SCRIPTS, 'seed_\\w+', ...PROJECT_DATA_SCRIPTS, 'start\\.sh', 'RUN_MIGRATIONS_ON_START',
    'update-index', 'skip-worktree', '\\.env', 'secrets', '\\.pem\\b', '\\.key\\b', '\\.ssh', '\\.aws',
    'launch\\.json', '\\.claude', 'CLAUDE\\.md', '\\brm\\b', 'Remove-Item', '\\bdel\\b', 'GIT_CONFIG',
  ].join('|'),
  'i',
);

// Intérpretes que pueden ejecutar lo que reciben por stdin (para heredocs no interpretables).
const HEREDOC_INTERP_VOCAB = /\b(bash|sh|zsh|dash|ksh|fish|busybox|git-bash|node|nodejs|deno|bun|python[\d.]*w?|py|perl|ruby|php|pwsh|powershell|cmd|lua|Rscript|tclsh|osascript|awk|gawk|xargs|env|source|eval|exec)\b/i;

// Scripts de datos del proyecto (lib/project.mjs); además, cualquier `seed_*` (SEED_RE).
export const DATA_SCRIPTS = PROJECT_DATA_SCRIPTS;
const SEED_RE = /^seed_\w+$/;
const isDeployScript = (n) => DEPLOY_SCRIPTS.some((s) => n.startsWith(s));

// Envoltorios que las reglas de Claude Code quitan (la forma sigue siendo canónica).
const STRIPPED_WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'git-bash', 'busybox', 'fish']);
const PWSH = new Set(['powershell', 'pwsh']);
// Programas con regla ask en settings.json (servidores, producción, migraciones). AG-16: `wsl` local ya no.
const ASK_PROGRAMS = new Set(['ssh', 'scp', 'sftp', 'rsync', 'tailscale', 'cloudflared', 'vercel', 'alembic']);
const CODE_INTERP = { node: ['-e', '--eval', '-p', '--print'], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], deno: ['eval'] };
const PY_RE = /^(python[\d.]*w?|py)$/;
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye']);

// Programas que no escriben (para autoprotección) y que sólo muestran metadatos (para SEC).
const READONLY = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'dir', 'stat', 'file',
  'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'echo', 'printf', 'test', '[', 'realpath',
  'readlink', 'basename', 'dirname', 'du', 'tree', 'pwd', 'type', 'which', 'where',
  'get-content', 'select-string', 'get-childitem', 'test-path', 'get-item', 'get-filehash', 'measure-object',
  'format-hex', 'resolve-path', 'split-path', 'join-path', 'get-acl', 'write-output', 'write-host',
]);
const METADATA_ONLY = new Set(['ls', 'dir', 'get-childitem', 'test-path', 'stat', 'du', 'tree']);
const WRITE_PROGS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'ln', 'tee', 'touch', 'truncate', 'dd', 'chmod', 'chown', 'sed', 'perl', 'install',
  'rsync', 'unlink', 'shred', 'remove-item', 'move-item', 'copy-item', 'set-content', 'add-content', 'out-file',
  'new-item', 'rename-item', 'clear-content', 'set-item', 'mkdir', 'new-itemproperty',
]);
const CD_PROGS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'push-location']);

// Alias de fábrica de Windows PowerShell 5.1 relevantes (Get-Alias) -> cmdlet en minúsculas.
const PS_ALIASES = {
  gc: 'get-content', cat: 'get-content', type: 'get-content', sc: 'set-content', ac: 'add-content',
  ri: 'remove-item', rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item',
  mi: 'move-item', mv: 'move-item', move: 'move-item', cpi: 'copy-item', cp: 'copy-item', copy: 'copy-item',
  ni: 'new-item', rni: 'rename-item', ren: 'rename-item', clc: 'clear-content', si: 'set-item',
  iex: 'invoke-expression', icm: 'invoke-command', saps: 'start-process', start: 'start-process',
  sls: 'select-string', gci: 'get-childitem', ls: 'get-childitem', dir: 'get-childitem', gi: 'get-item',
  sl: 'set-location', cd: 'set-location', chdir: 'set-location', pushd: 'push-location',
  sal: 'set-alias', nal: 'new-alias', ipal: 'import-alias', echo: 'write-output', write: 'write-output',
  ipmo: 'import-module', nsn: 'new-pssession', etsn: 'enter-pssession',
};

const GIT_BUILTINS = new Set(`add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore
check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph
commit-tree config count-objects credential describe diff diff-files diff-index diff-tree difftool fast-export fast-import
fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui
hash-object help hook index-pack init instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit
maintenance merge merge-base merge-file merge-index merge-tree mktag mktree multi-pack-index mv name-rev notes pack-objects
pack-redundant pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog remote repack replace
request-pull rerere reset restore rev-list rev-parse revert rm send-email shortlog show show-branch show-index show-ref
sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index
update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree write-tree`.split(/\s+/));

const SAFE_GIT_C_KEYS = /^(color\..*|core\.quotepath|user\.name|user\.email|advice\..*|i18n\..*|core\.autocrlf|init\.defaultbranch|log\..*|diff\.(color.*|renames|algorithm)|pager\..*=false)$/i;

// ---------------- utilidades ----------------
export function progName(t) {
  let s = String(t).replace(/\\/g, '/');
  s = s.slice(s.lastIndexOf('/') + 1).toLowerCase();
  return s.replace(/\.(exe|cmd|bat|com)$/, '');
}

function isBare(w) {
  return w.text !== null && !w.quoted && w.raw === w.text && !/[\\/]/.test(w.text) && !/\.(exe|cmd|bat|com)$/i.test(w.text);
}

const lit = (w) => (w ? w.text : null);

class Out {
  constructor() { this.deny = []; this.ask = []; }
  d(rule, msg) { this.deny.push({ rule, msg }); }
  a(rule, msg) { this.ask.push({ rule, msg }); }
  merge(o) { this.deny.push(...o.deny); this.ask.push(...o.ask); }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}
function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

// ---------------- análisis de un texto de shell ----------------
/**
 * ctx: { cwd, root, depth, canonical, shell }
 * Devuelve Out con hallazgos.
 */
export async function analyzeShell(text, shell, ctx) {
  const out = new Out();
  const depth = ctx.depth ?? 0;
  if (depth > MAX_DEPTH) { out.d('H-13', 'anidamiento de shells demasiado profundo'); return out; }
  if (SUSPICIOUS_CHARS.test(text)) { out.d('H-13', 'caracteres de control, invisibles o bidireccionales en el comando'); return out; }
  if (text.length > 20000 && SENSITIVE_VOCAB.test(text)) { out.d('H-13', 'comando demasiado largo con vocabulario sensible'); return out; }

  const parsed = shell === 'ps' ? parsePowerShell(text) : await parseBash(text);
  if (parsed.hasError && SENSITIVE_VOCAB.test(text)) {
    out.d('H-13', `el parser (${shell === 'ps' ? 'AST de PowerShell' : 'tree-sitter-bash'}) no pudo interpretar el comando y toca algo sensible`);
  }
  // Heredoc que tree-sitter no pudo estructurar: el receptor puede ser un intérprete fuera del análisis.
  if (parsed.heredocError && HEREDOC_INTERP_VOCAB.test(text)) {
    out.d('H-13', 'heredoc con estructura no interpretable por tree-sitter-bash junto a un intérprete: no verificable');
  }

  // Variables de entorno / asignaciones visibles en el texto (H-11, start.sh).
  const envText = [];
  if (shell === 'ps') {
    for (const op of parsed.opaque) {
      const m = String(op.member).replace(/['"]/g, '').toLowerCase();
      if (['start', 'create', 'invoke', 'invokescript', 'addscript', 'addcommand', 'addstatement', 'executecommand', 'newscriptblock', 'run', 'invokereturnasis'].includes(m)) {
        out.d('H-13', `invocación .NET opaca (${op.member}) no analizable`);
      }
    }
    for (const a of parsed.assigns) {
      const nm = String(a.name || '');
      envText.push(`${nm}=${a.value ? a.value.approx : ''}`);
      if (/^env:GIT_CONFIG/i.test(nm) || (a.drive === 'env' && /GIT_CONFIG/i.test(nm))) out.d('H-11', 'GIT_CONFIG_* puede inyectar alias o config de git');
    }
    // Literales fuera de comandos (variables, métodos .NET como [IO.File]::ReadAllText('.env')).
    for (const s of parsed.strings) {
      if (P.sensitiveReason(s, P.resolveFrom(ctx.cwd, s))) { out.d('SEC', 'literal que apunta a un archivo sensible'); break; }
    }
  } else {
    for (const d of parsed.declarations) {
      envText.push(d);
      if (/\bGIT_CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL|SYSTEM)/i.test(d)) out.d('H-11', 'GIT_CONFIG_* puede inyectar alias o config de git');
      const val = d.includes('=') ? d.slice(d.indexOf('=') + 1).replace(/^['"]|['"]$/g, '') : '';
      if (val && P.sensitiveReason(val, P.resolveFrom(ctx.cwd, val))) out.d('SEC', 'variable que apunta a un archivo sensible');
    }
    for (const c of parsed.commands) for (const a of c.assigns) {
      const v = a.value?.text ?? a.value?.approx;
      if (v && P.sensitiveReason(v, P.resolveFrom(ctx.cwd, v))) out.d('SEC', 'variable que apunta a un archivo sensible');
    }
  }

  // Directorios candidatos (cd dentro del mismo comando).
  const dirs = new Set([P.norm(ctx.cwd)]);
  let dirsDynamic = false;
  for (const c of parsed.commands) {
    const w0 = c.words[0];
    if (!w0 || w0.text === null) continue;
    let nm = progName(w0.text);
    if (shell === 'ps') nm = PS_ALIASES[nm] ?? nm;
    if (!CD_PROGS.has(nm)) continue;
    const tgt = c.words.slice(1).find((w) => w.text === null || !w.text.startsWith('-'));
    if (!tgt) continue;
    if (tgt.text === null) { dirsDynamic = true; continue; }
    for (const base of [...dirs]) dirs.add(P.resolveFrom(base, tgt.text));
  }
  const sub = { ...ctx, depth, dirs: [...dirs], dirsDynamic, envText, shell };

  for (const c of parsed.commands) {
    await analyzeCommand(c, sub, out);
  }
  // Bash: redirecciones sin comando asociado (estructura con ERROR); mismo control que las propias.
  for (const r of parsed.orphanRedirects ?? []) {
    checkPathWord(r.target, sub, out, { write: r.write, program: r.write ? '>' : '<', redirect: true });
  }

  // PowerShell: gci -Recurse | Select-String / Get-Content (D-5)
  if (shell === 'ps') psRecursiveReads(parsed.commands, sub, out);
  return out;
}

async function nested(text, shell, ctx, out, why) {
  const r = await analyzeShell(text, shell, { ...ctx, depth: (ctx.depth ?? 0) + 1, canonical: false, via: why });
  out.merge(r);
}

function readScript(ctx, p) {
  const full = P.resolveFrom(ctx.cwd, p);
  if (P.sensitiveReason(p, full)) return { sensitive: true };
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > 512 * 1024) return { exists: true, text: null };
    return { exists: true, text: fs.readFileSync(full, 'utf8'), full };
  } catch { return { exists: false }; }
}

// ---------------- un comando simple ----------------
async function analyzeCommand(cmd, ctx, out) {
  let words = cmd.words.slice();
  let canonical = ctx.canonical !== false && !cmd.inFunction && !cmd.inScriptBlock;
  if (cmd.shell === 'ps' && cmd.invocation && cmd.invocation !== 'Unknown') canonical = false;
  const assigns = cmd.assigns.slice();
  for (const a of assigns) {
    if (/^GIT_CONFIG/i.test(a.name)) out.d('H-11', 'GIT_CONFIG_* puede inyectar alias o config de git');
  }

  // Redirecciones: archivos sensibles y autoprotección.
  for (const r of cmd.redirects) {
    if (!r.target) continue;
    checkPathWord(r.target, ctx, out, { write: r.write, program: r.write ? '>' : '<', redirect: true });
  }

  if (words.length === 0) return;

  // ---- desenvolver ----
  for (let guard = 0; guard < 10 && words.length; guard++) {
    const w0 = words[0];
    if (w0.text === null) { out.d('H-13', `nombre de programa dinámico (${w0.raw}) no verificable`); return; }
    let name = progName(w0.text);
    if (cmd.shell === 'ps') name = PS_ALIASES[name] ?? name;
    if (name === 'sudo') { out.d('H-04', 'sudo está bloqueado'); return; }
    if (STRIPPED_WRAPPERS.has(name)) {
      if (!isBare(w0)) canonical = false;
      if (name === 'command' && words.slice(1).some((w) => w.text === '-v' || w.text === '-V')) return; // sólo consulta
      words = skipWrapperOptions(name, words.slice(1));
      continue;
    }
    if (name === 'xargs') {
      let i = 1;
      const valOpts = new Set(['-I', '-i', '-n', '-L', '-l', '-P', '-d', '-E', '-e', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace', '--eof', '--max-chars']);
      if (words.length > 1 && words[1].text && words[1].text.startsWith('-')) canonical = false;
      while (i < words.length && words[i].text && words[i].text.startsWith('-')) { i += valOpts.has(words[i].text) && !words[i].text.includes('=') ? 2 : 1; }
      words = [...words.slice(i), { text: null, raw: '<xargs>', approx: '', quoted: false, glob: false }];
      if (words.length === 1) words = [{ text: 'echo', raw: 'echo', approx: 'echo', quoted: false, glob: false }];
      continue;
    }
    if (name === 'env') {
      canonical = false;
      let i = 1;
      for (; i < words.length; i++) {
        const t = words[i].text;
        if (t === null) { out.d('H-13', 'argumento dinámico en env'); return; }
        if (t === '-S' || t.startsWith('--split-string') || /^-[a-zA-Z]*S/.test(t)) { out.d('H-13', 'env -S (cadena opaca)'); return; }
        if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir') { i++; continue; }
        if (t.startsWith('-')) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { assigns.push({ name: t.split('=')[0], value: { text: t.split('=').slice(1).join('='), raw: t, approx: t } }); if (/^GIT_CONFIG/i.test(t)) out.d('H-11', 'GIT_CONFIG_* vía env'); continue; }
        break;
      }
      words = words.slice(i);
      continue;
    }
    if (name === 'exec' && cmd.shell === 'bash') {
      canonical = false;
      let i = 1;
      while (i < words.length && words[i].text && words[i].text.startsWith('-')) i += words[i].text === '-a' ? 2 : 1;
      words = words.slice(i);
      continue;
    }
    break;
  }
  if (!words.length) return;

  const w0 = words[0];
  if (w0.text === null) { out.d('H-13', `nombre de programa dinámico (${w0.raw}) no verificable`); return; }
  let name = progName(w0.text);
  if (cmd.shell === 'ps') name = PS_ALIASES[name] ?? name;
  if (!isBare(w0)) canonical = false;
  const args = words.slice(1);
  const c2 = { ...ctx, canonical, assigns, cmd };

  // ---- programas especiales ----
  if (isDeployScript(name)) { out.d('H-05', 'el script de deploy de F1 no se ejecuta'); return; }

  if (name === 'claude') return claudePolicy(args, out);

  if (name === 'eval' || name === 'trap' || name === 'watch') {
    const body = name === 'trap' ? args.slice(0, 1) : args;
    if (body.some((w) => w.text === null)) { out.d('H-13', `${name} con contenido dinámico`); return; }
    if (body.length) await nested(body.map((w) => w.text).join(' '), 'bash', c2, out, name);
    return;
  }
  if (name === 'source' || name === '.') {
    const f = args[0];
    if (!f) return;
    if (f.text === null) { out.d('H-13', `${name} de un archivo dinámico`); return; }
    return runScriptFile(f.text, 'bash', c2, out);
  }
  if (name === 'invoke-expression') { out.d('H-13', 'Invoke-Expression/iex no es analizable'); return; }
  if (name === 'set-alias' || name === 'new-alias' || name === 'import-alias') { out.d('H-13', 'definir alias de PowerShell oculta comandos'); return; }
  if (name === 'start-process') return startProcess(args, c2, out);
  if (name === 'invoke-command') {
    for (let i = 0; i < args.length; i++) {
      const t = (args[i].text || '').toLowerCase();
      if (t.startsWith('-filepath')) { const f = args[i].argument ?? args[i + 1]; if (!f || f.text === null) { out.d('H-13', 'Invoke-Command -FilePath dinámico'); return; } return runScriptFile(f.text, 'ps', c2, out); }
    }
  }

  if (SHELLS.has(name)) return shellInterp(name, args, cmd, c2, out);
  if (PWSH.has(name)) return pwshInterp(args, cmd, c2, out);
  if (name === 'cmd') return cmdInterp(args, cmd, c2, out);

  if (name === 'find') await findExec(args, c2, out);

  if (name === 'git') return gitPolicy(args, c2, out, w0, 0);
  if (name === 'docker' || name === 'docker-compose') return dockerPolicy(name, args, c2, out, w0);

  if (ASK_PROGRAMS.has(name)) {
    if (!canonical) out.d('H-07', `"${name}" en forma no canónica: escribilo como \`${name} ...\` simple para que pase por la confirmación`);
    // canónico: lo resuelve la regla ask de settings.json
  }
  // AG-20: wsl ejecuta comandos en Linux fuera del análisis (ssh, git push, rutas /mnt/c sin traducir).
  // Sólo se permiten las consultas de estado; el resto se bloquea.
  if (name === 'wsl') {
    const WSL_INFO = new Set(['-l', '--list', '-v', '--verbose', '-q', '--quiet', '--running', '--all', '--status', '--version', '--help', '--shutdown']);
    if (!args.length || args.some((w) => w.text === null || !WSL_INFO.has(w.text.toLowerCase()))) {
      out.d('H-07', 'wsl ejecuta comandos fuera del análisis del hook; usá la terminal de Windows o pedile al owner que lo corra');
    }
    return;
  }
  if (name === 'gh') {
    const a0 = lit(args[0]), a1 = lit(args[1]);
    if (args.slice(0, 2).some((w) => w.text === null)) { out.d('H-13', 'gh con subcomando dinámico'); return; }
    if ((a0 === 'pr' && a1 === 'merge') || (a0 === 'workflow' && a1 === 'run')) {
      if (!canonical) out.d('H-07', `gh ${a0} ${a1} en forma no canónica`);
    }
    // AG-20: otras formas de mergear o disparar el deploy sin pasar por `gh pr merge`/`gh workflow run`.
    if (a0 === 'run' && a1 === 'rerun') out.a('D-10', 'gh run rerun puede volver a correr el deploy de main');
    if (a0 === 'api') {
      const texts = args.slice(1).map((w) => w.text);
      if (texts.some((t) => t === null)) { out.d('H-13', 'gh api con argumentos dinámicos'); return; }
      const mi = texts.findIndex((t) => /^(-X|--method)(=|$)/.test(t) || /^-X[A-Za-z]+$/.test(t));
      const method = mi < 0 ? null : (texts[mi].includes('=') ? texts[mi].split('=')[1] : texts[mi].length > 2 && texts[mi].startsWith('-X') ? texts[mi].slice(2) : texts[mi + 1]);
      const writesBody = texts.some((t) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(t));
      const write = (method && method.toUpperCase() !== 'GET') || (!method && writesBody);
      if (write || texts.some((t) => /\/(merge|dispatches|rerun|rerun-failed-jobs)\b/.test(t))) {
        out.a('D-10', 'gh api con escritura sobre GitHub (merge, dispatch o rerun posibles)');
      }
    }
  }
  if (['npx', 'pnpm', 'bunx', 'yarn', 'npm', 'pnpx'].includes(name)) packageRunner(name, args, c2, out);

  if (PY_RE.test(name) || RUNNERS.has(name)) await pythonPolicy(name, args, cmd, c2, out);
  if (name === 'pytest' || name === 'py.test') pyToolGuard('pytest', args, out, c2);
  if (CODE_INTERP[name]) inlineCode(name, args, cmd, out, c2);

  // Ejecutar un script por ruta (./x.sh, deploy/f1/x.sh, .\x.ps1)
  if (/[\\/]/.test(w0.text) || /\.(sh|bash|ps1)$/i.test(w0.text)) {
    if (/\.(sh|bash)$/i.test(w0.text)) await runScriptFile(w0.text, 'bash', c2, out);
    else if (/\.ps1$/i.test(w0.text)) await runScriptFile(w0.text, 'ps', c2, out);
  }

  // ---- chequeos genéricos ----
  dataScripts(name, words, cmd, c2, out);
  const skip = exclusionValueIndexes(name, args);
  args.forEach((w, k) => { if (!skip.has(k)) checkPathWord(w, c2, out, { write: false, program: name, args }); });
  protectedWrite(name, args, c2, out);
  recursiveSearch(name, args, c2, out);
}

function skipWrapperOptions(name, ws) {
  let i = 0;
  const take = (n) => { i += n; };
  if (name === 'timeout') {
    while (i < ws.length && ws[i].text && ws[i].text.startsWith('-')) take(['-s', '-k', '--signal', '--kill-after'].includes(ws[i].text) ? 2 : 1);
    take(1); // duración
  } else if (name === 'nice') {
    while (i < ws.length && ws[i].text && ws[i].text.startsWith('-')) take(ws[i].text === '-n' ? 2 : 1);
  } else {
    while (i < ws.length && ws[i].text && /^-/.test(ws[i].text)) take(['-i', '-o', '-e'].includes(ws[i].text) ? 2 : 1);
  }
  return ws.slice(i);
}

// ---------------- D-6 claude anidado ----------------
function claudePolicy(args, out) {
  const t = args.map((w) => w.text);
  const ok = [['--version'], ['-v'], ['--help'], ['-h'], ['doctor']];
  if (ok.some((o) => o.length === t.length && o.every((x, i) => x === t[i]))) return;
  out.d('D-6', 'no se inician sesiones anidadas de Claude (sólo claude --version / --help / doctor)');
}

// ---------------- intérpretes ----------------
async function runScriptFile(p, shell, ctx, out) {
  const base = progName(p);
  if (isDeployScript(base)) { out.d('H-05', 'el script de deploy de F1 no se ejecuta'); return; }
  if (base === 'start.sh') return startSh(ctx, out);
  const s = readScript(ctx, p);
  if (s.sensitive) { out.d('SEC', 'ejecutar un archivo sensible'); return; }
  if (!s.exists) { out.d('H-13', `script inexistente al momento del análisis (${p}): no verificable`); return; }
  if (s.text === null) { if (SENSITIVE_VOCAB.test(p)) out.d('H-13', `script ilegible (${p})`); return; }
  await nested(s.text, shell, ctx, out, `script ${p}`);
}

function startSh(ctx, out) {
  const env = [...(ctx.assigns || []).map((a) => `${a.name}=${a.value?.approx ?? ''}`), ...(ctx.envText || [])].join('\n');
  if (/RUN_MIGRATIONS_ON_START/i.test(env) || /RUN_MIGRATIONS_ON_START/i.test(ctx.cmd?.source || '') || process.env.RUN_MIGRATIONS_ON_START) {
    out.d('H-06', 'backend/start.sh con RUN_MIGRATIONS_ON_START ejecuta migraciones');
  }
}

async function shellInterp(name, args, cmd, ctx, out) {
  let i = 0;
  const valOpts = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
  let script = null;
  while (i < args.length) {
    const t = args[i].text;
    if (t === null) { out.d('H-13', `${name} con opción dinámica`); return; }
    if (t === '-c' || (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t) && !t.startsWith('--'))) {
      const body = args[i + 1];
      if (!body) return;
      if (body.text === null) { out.d('H-13', `${name} -c con contenido dinámico`); return; }
      return nested(body.text, name === 'fish' ? 'bash' : 'bash', ctx, out, `${name} -c`);
    }
    if (valOpts.has(t)) { i += 2; continue; }
    if (t === '-s' || t === '--') { i++; if (t === '--') { script = args[i] ?? null; } break; }
    if (t.startsWith('-') || t.startsWith('+')) { i++; continue; }
    script = args[i];
    break;
  }
  if (script && script.text !== null) return runScriptFile(script.text, 'bash', ctx, out);
  if (script && script.text === null) { out.d('H-13', `${name} con script dinámico`); return; }
  return stdinToInterpreter(name, 'bash', cmd, ctx, out);
}

async function stdinToInterpreter(name, shell, cmd, ctx, out) {
  const st = cmd.stdin || { kind: 'none' };
  if (st.kind === 'literal') return nested(st.text, shell, ctx, out, `stdin de ${name}`);
  if (st.kind === 'dynamic') { out.d('H-13', `${name} recibe por stdin código no literal`); return; }
  if (st.kind === 'file') {
    // bash.mjs asocia el destino de la redirección de entrada efectiva (fd 0); PowerShell no lo trae.
    const target = st.target ?? cmd.redirects.find((x) => x.op === '<')?.target;
    if (!target || target.text === null) { out.d('H-13', `${name} lee código de un archivo dinámico`); return; }
    return runScriptFile(target.text, shell, ctx, out);
  }
}

async function pwshInterp(args, cmd, ctx, out) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === null) { out.d('H-13', 'powershell con argumento dinámico'); return; }
    const lt = t.toLowerCase();
    if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand|encodeda.*)$/.test(lt)) { out.d('H-13', 'powershell -EncodedCommand no es analizable'); return; }
    if (/^-(c|co|com|comm|comma|comman|command)$/.test(lt)) {
      const rest = args.slice(i + 1);
      if (rest.length === 1 && rest[0].text === '-') return stdinToInterpreter('powershell', 'ps', cmd, ctx, out);
      if (rest.some((w) => w.text === null)) { out.d('H-13', 'powershell -Command dinámico'); return; }
      return nested(rest.map((w) => w.text).join(' '), 'ps', ctx, out, 'powershell -Command');
    }
    if (/^-(f|fi|fil|file)$/.test(lt)) {
      const f = args[i + 1];
      if (!f || f.text === null) { out.d('H-13', 'powershell -File dinámico'); return; }
      return runScriptFile(f.text, 'ps', ctx, out);
    }
    if (['-executionpolicy', '-ex', '-ep', '-windowstyle', '-w', '-version', '-v', '-outputformat', '-o', '-inputformat', '-if', '-configurationname', '-workingdirectory', '-wd', '-settingsfile'].includes(lt)) { i++; continue; }
    if (lt === '-') return stdinToInterpreter('powershell', 'ps', cmd, ctx, out);
    if (lt.startsWith('-')) continue;
    // Primer posicional: Windows PowerShell lo toma como -Command; pwsh como -File. Se analiza como código.
    const rest = args.slice(i);
    if (rest.some((w) => w.text === null)) { out.d('H-13', 'powershell con comando dinámico'); return; }
    const asFile = /\.ps1$/i.test(t) ? readScript(ctx, t) : null;
    if (asFile && asFile.exists) return runScriptFile(t, 'ps', ctx, out);
    return nested(rest.map((w) => w.text).join(' '), 'ps', ctx, out, 'powershell');
  }
  return stdinToInterpreter('powershell', 'ps', cmd, ctx, out);
}

function cmdInterp(args, cmd, ctx, out) {
  const i = args.findIndex((w) => w.text && /^\/[ck]$/i.test(w.text));
  const body = i >= 0 ? args.slice(i + 1) : [];
  if (body.some((w) => w.text === null)) { out.d('H-13', 'cmd /c con contenido dinámico'); return; }
  const text = body.map((w) => w.text).join(' ') + (cmd.stdin && cmd.stdin.kind !== 'none' ? '\n' + cmd.stdin.text : '');
  if (cmd.stdin && cmd.stdin.kind === 'dynamic') { out.d('H-13', 'cmd recibe por stdin código no literal'); return; }
  // cmd.exe no tiene parser disponible: heurística conservadora por vocabulario.
  if (SENSITIVE_VOCAB.test(text)) out.d('H-13', 'cmd.exe no es analizable y el comando toca algo sensible');
}

async function startProcess(args, ctx, out) {
  let file = null, argList = null, i = 0;
  const pos = [];
  for (; i < args.length; i++) {
    const w = args[i];
    const t = (w.text ?? '').toLowerCase();
    if (w.param || t.startsWith('-')) {
      const val = w.argument ?? args[i + 1];
      if (/^-(filepath|fi|f|path)$/.test(t)) { file = val; if (!w.argument) i++; continue; }
      if (/^-(argumentlist|args|a|ar|arg|argu|argum|argume|argumen|argument|argumentl)$/.test(t)) { argList = val; if (!w.argument) i++; continue; }
      if (/^-(verb|workingdirectory|redirectstandard\w*|windowstyle|credential)$/.test(t)) { if (!w.argument) i++; continue; }
      continue;
    }
    pos.push(w);
  }
  if (!file) file = pos[0];
  if (!argList) argList = pos[1];
  if (!file || file.text === null) { out.d('H-13', 'Start-Process con programa dinámico'); return; }
  let argv = [];
  if (argList) {
    if (argList.items) { if (argList.items.some((x) => x.text === null)) { out.d('H-13', 'Start-Process con argumentos dinámicos'); return; } argv = argList.items.map((x) => x.text); }
    else if (argList.text === null) { out.d('H-13', 'Start-Process con argumentos dinámicos'); return; }
    else argv = [argList.text];
  }
  // Se re-analiza como si fuera una línea de bash (forma no canónica).
  const line = [file.text, ...argv].map((s) => (/^[\w./:\\=+,@%-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`)).join(' ');
  return nested(line, 'bash', ctx, out, 'Start-Process');
}

async function findExec(args, ctx, out) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      const end = args.findIndex((w, j) => j > i && (w.text === ';' || w.text === '+' || w.text === '\\;'));
      const sub = args.slice(i + 1, end < 0 ? args.length : end);
      if (sub.some((w) => w.text === null && w.raw !== '{}')) { out.d('H-13', 'find -exec con comando dinámico'); return; }
      const line = sub.map((w) => (w.text === '{}' ? 'FINDARG' : w.raw)).join(' ');
      await nested(line, 'bash', ctx, out, 'find -exec');
    }
    if (t === '-delete') protectedWrite('rm', args.filter((w) => w.text && !w.text.startsWith('-')), ctx, out);
  }
}

// ---------------- paquetes (npx vercel, claude) ----------------
function packageRunner(name, args, ctx, out) {
  let i = 0;
  if (name === 'pnpm' || name === 'yarn') { if (!['dlx', 'exec'].includes(lit(args[0]))) return; i = 1; }
  if (name === 'npm') { if (!['exec', 'x'].includes(lit(args[0]))) return; i = 1; }
  let flagsBefore = false;
  for (; i < args.length; i++) {
    const t = args[i].text;
    if (t === null) { out.d('H-13', `${name} con paquete dinámico`); return; }
    if (t === '-c' || t === '--call') { out.d('H-13', `${name} -c (cadena opaca)`); return; }
    if (t === '-p' || t === '--package') { flagsBefore = true; i++; continue; }
    if (t.startsWith('-')) { flagsBefore = true; continue; }
    break;
  }
  const pkg = (lit(args[i]) || '').toLowerCase().replace(/@[^/@]*$/, '');
  if (pkg === 'vercel') {
    if (!(name === 'npx' && !flagsBefore && i === 0 && ctx.canonical)) out.d('H-07', 'vercel sólo como `vercel ...` o `npx vercel ...` (forma canónica con confirmación)');
  }
  if (pkg === 'claude' || pkg === '@anthropic-ai/claude-code') out.d('D-6', 'no se inician sesiones anidadas de Claude');
}

// ---------------- Python y scripts de datos ----------------
async function pythonPolicy(name, args, cmd, ctx, out) {
  let a = args;
  if (RUNNERS.has(name)) {
    // uv run [opts] X ... | poetry run X ...
    const i = a.findIndex((w) => w.text === 'run');
    if (i < 0) return;
    a = a.slice(i + 1);
    while (a.length && a[0].text && a[0].text.startsWith('-')) a = a.slice(['--with', '--python', '-p', '--env-file', '--project', '--directory', '--package'].includes(a[0].text) ? 2 : 1);
    if (!a.length) return;
    if (a[0].text === null) { out.d('H-13', `${name} run con programa dinámico`); return; }
    const inner = progName(a[0].text);
    if (inner === 'alembic') { out.d('H-07', `alembic vía ${name} run no pasa por la confirmación: usá \`alembic ...\``); return; }
    if (inner === 'pytest') { pyToolGuard('pytest', a.slice(1), out, ctx); return; }
    if (!PY_RE.test(inner)) return;
    a = a.slice(1);
  }
  for (let i = 0; i < a.length; i++) {
    const t = a[i].text;
    if (t === null) continue;
    if (t === '-m') {
      const m = lit(a[i + 1]);
      if (m === null) { out.d('H-13', 'python -m con módulo dinámico'); return; }
      if (/^alembic$/i.test(m)) { out.d('H-07', 'python -m alembic no pasa por la confirmación: usá `alembic ...`'); return; }
      pyToolGuard(m, a.slice(i + 2), out, ctx);
      break;
    }
    if (t === '-c') {
      const code = a[i + 1];
      if (!code) return;
      if (code.text === null) {
        if (SENSITIVE_VOCAB.test(code.approx)) out.d('H-13', 'python -c dinámico con vocabulario sensible');
        codeProtected(code.approx, ctx, out, 'python -c', true);
        return;
      }
      codeScan(code.text, out, ctx, 'python -c');
      return;
    }
    if (t === '-' || !t.startsWith('-')) break;
  }
  const st = cmd.stdin || { kind: 'none' };
  const hasScript = a.some((w) => w.text && !w.text.startsWith('-'));
  if (!hasScript && st.kind === 'literal') codeScan(st.text, out, ctx, 'stdin de python', !!st.expands);
  if (!hasScript && st.kind === 'dynamic' && SENSITIVE_VOCAB.test(st.text)) out.d('H-13', 'python recibe por stdin código no literal');
  if (!hasScript && st.kind === 'dynamic') out.d('H-13', 'python lee el programa de un stdin no literal: no verificable');
}

// AG-16 (2026-11-14): pytest y ruff corren con cualquier opción sin confirmación (ex D-9). Sólo se
// bloquea `--basetemp` hacia los controles, porque pytest vacía ese directorio antes de usarlo.
function pyToolGuard(module, rest, out, ctx) {
  if (String(module).toLowerCase() !== 'pytest' || !ctx) return;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].text;
    if (t === null) continue;
    // Incluye prefijos que argparse acepta (--base, --baset...) y la forma dentro de -o addopts=.
    const m = /(?:^|[\s=])--base(?:t(?:e(?:m(?:p)?)?)?)?(?:=(.*))?$/.exec(t);
    if (!m) continue;
    const target = m[1] !== undefined ? m[1] : rest[i + 1]?.text;
    if (target == null) {
      if (m[1] === undefined && rest[i + 1] && rest[i + 1].text === null) { out.d('H-12', 'pytest --basetemp con destino dinámico'); return; }
      continue;
    }
    for (const d of ctx.dirs || [ctx.cwd]) {
      const hit = P.protectedHit(ctx.root, P.resolveFrom(d, target));
      if (hit) { out.d('H-12', `pytest --basetemp sobre un control protegido (${path.basename(hit)})`); return; }
    }
  }
}

/** Literales entre comillas dentro de código inline que apuntan a archivos sensibles. */
function codeSensitive(code, out) {
  for (const m of String(code).matchAll(/(['"`])([^'"`\n]{1,300})\1/g)) {
    if (P.sensitiveReason(m[2], m[2])) { out.d('SEC', 'código inline que referencia un archivo sensible'); return true; }
  }
  return false;
}

function codeScan(code, out, ctx, label, dynamic = false) {
  codeSensitive(code, out);
  const re = new RegExp(`\\b(${[...DATA_SCRIPTS, 'seed_\\w+'].join('|')})\\b`);
  if (re.test(code)) out.d('H-06', 'el código referencia un script de datos bloqueado');
  if (/\b(subprocess|os\.system|os\.popen|child_process|execSync|spawn|Popen|system\()/.test(code) && SENSITIVE_VOCAB.test(code)) {
    out.d('H-13', 'código inline que lanza procesos con vocabulario sensible');
  }
  if (ctx) codeProtected(code, ctx, out, label ?? 'código inline', dynamic);
}

function inlineCode(name, args, cmd, out, ctx) {
  const flags = CODE_INTERP[name];
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i].text)) {
      const code = args[i + 1];
      if (!code) return;
      const txt = code.text ?? code.approx;
      if (codeSensitive(txt, out)) return;
      if (SENSITIVE_VOCAB.test(txt) && (code.text === null || /\b(exec|spawn|system|popen|child_process|`|Deno\.run|Command)\b/.test(txt) || /\.(env|pem|key)\b|secrets|\.ssh|\.aws|launch\.json/.test(txt))) {
        out.d('H-13', `${name} con código inline que toca algo sensible`);
      }
      if (ctx) codeProtected(txt, ctx, out, `${name} ${args[i].text}`, code.text === null);
      return;
    }
  }
  const st = cmd.stdin;
  if (st && st.kind !== 'none' && SENSITIVE_VOCAB.test(st.text)) out.d('H-13', `${name} recibe por stdin código con vocabulario sensible`);
  // Sin script por argumento, el intérprete lee el programa de stdin (heredoc, here-string, pipe literal).
  const hasScript = args.some((w) => w.text === null || (w.text !== '-' && !w.text.startsWith('-')));
  if (ctx && st && !hasScript) {
    if (st.kind === 'literal') codeProtected(st.text, ctx, out, `stdin de ${name}`, !!st.expands);
    else if (st.kind === 'dynamic') out.d('H-13', `${name} lee el programa de un stdin no literal: no verificable`);
  }
}

// ---------------- P0.2: código inline frente a las rutas protegidas ----------------
// Análisis ESTÁTICO y heurístico del texto del programa (no se ejecuta): busca literales de ruta
// y APIs de escritura de Node/Deno/Bun, Python, Perl, Ruby y PHP. No puede decidir qué hace un
// programa arbitrario (cadenas armadas en tiempo de ejecución, codificación, reflexión); por eso,
// cuando hay señales de escritura junto con referencias directas, construidas u opacas a los
// controles, se bloquea. La lectura de los controles con rutas literales se sigue permitiendo.
// La clasificación de rutas es la de paths.mjs (protectedHit / protectedDocHit): no se duplica.

/** APIs que crean, modifican, mueven o borran archivos. */
const CODE_WRITE_API = new RegExp([
  // Node (fs, fs/promises, fs-extra), Deno, Bun
  '\\b(writeFile|appendFile|rm|rmdir|unlink|rename|copyFile|cp|mkdir|mkdtemp|truncate|ftruncate|symlink|link|chmod|chown|lchown|utimes|lutimes|futimes)(Sync)?\\s*\\(',
  '\\bcreateWriteStream\\b', '\\.(outputFile|outputJson|writeJson|remove|move|copy|emptyDir|ensureFile|ensureDir|mkdirp|mkdirs)(Sync)?\\s*\\(',
  '\\bDeno\\.(write\\w*|remove|rename|copyFile|mkdir|create|truncate|symlink|link|chmod|chown|utime|makeTemp\\w*)\\b', '\\bBun\\.write\\b',
  // apertura con modo de escritura: open/openSync/fopen/File.open/Path.open/io.open
  '\\b(f?open|openSync)\\s*\\([^)]*[\'"][rbt]*[wax+][rwabxt+]*[\'"]', '\\bO_(WRONLY|RDWR|CREAT|TRUNC|APPEND)\\b',
  // Python
  '\\bos\\.(replace|rename|renames|remove|unlink|rmdir|removedirs|makedirs|mkdir|chmod|chown|lchown|symlink|link|truncate|utime|write)\\b',
  '\\bshutil\\.(copy\\w*|move|rmtree|chown)\\b', '\\.(write_text|write_bytes|unlink|rmdir|touch|symlink_to|hardlink_to|link_to)\\s*\\(',
  // Perl
  '\\bopen\\b[^;]*[\'"]\\s*(\\+?>|\\+<|>>)', '\\bFile::(Copy|Path)\\b', '\\b(unlink|rmtree|make_path|remove_tree)\\b',
  // Ruby
  '\\b(File|IO)\\.(write|binwrite|delete|unlink|rename|symlink|link|chmod|chown|truncate|utime)\\b', '\\bFileUtils\\b', '\\bDir\\.(mkdir|rmdir|delete|unlink)\\b',
  // PHP
  '\\b(file_put_contents|fwrite|fputs|tempnam|touch)\\s*\\(',
].join('|'));

/** Borrado o movimiento: peligroso aunque apunte a un directorio que contiene los controles. */
const CODE_DESTRUCTIVE_API = /\b(rm|rmdir|unlink|rename)(Sync)?\s*\(|\.(remove|move|emptyDir)(Sync)?\s*\(|\bDeno\.(remove|rename)\b|\bos\.(replace|rename|renames|remove|unlink|rmdir|removedirs)\b|\bshutil\.(move|rmtree)\b|\.(unlink|rmdir)\s*\(|\b(rmtree|remove_tree)\b|\bFileUtils\.(rm\w*|mv|move|remove\w*)\b|\b(File|Dir)\.(delete|unlink|rename|rmdir)\b/;

/** Lanzamiento de procesos: el proceso hijo puede escribir cualquier cosa. */
const CODE_PROC_API = /\b(child_process|execSync|execFileSync|spawnSync|execFile|spawn|fork|subprocess|Popen|os\.system|os\.popen|os\.exec\w*|os\.spawn\w*|pty\.spawn|shell_exec|passthru|proc_open|popen|Deno\.(run|Command)|Bun\.spawn\w*|Open3|IO\.popen)\b|\bBun\.\$|\bsystem\s*\(|\bqx\b/;

/**
 * Código que se arma, decodifica o resuelve por reflexión en tiempo de ejecución: su efecto no es
 * visible estáticamente. Acotado a construcciones que ejecutan o esconden nombres (no .digest('hex')).
 */
const CODE_OPAQUE_API = /(?<![.\w])(eval|exec|compile|Function|__import__|getattr|setattr|create_function|instance_eval|class_eval|module_eval)\b|\b(importlib|runpy|vm\.\w+|runInNewContext|runInThisContext|runInContext|fromCharCode|atob|b64decode|a85decode|b32decode|unhexlify|bytes\.fromhex|base64_decode|hex2bin|str_rot13|gzinflate|gzuncompress)\b|\bnew\s+Function\b|\b(globals|vars|locals)\s*\(\s*\)\s*\[|\bBuffer\.from\s*\([^)]*['"](base64|base64url|hex)['"]|\bdecode\s*\(\s*['"](base64|hex|rot13)|\.(send|__send__|public_send)\s*\(\s*:|\b(fs|fsp|os|shutil|pathlib|Path|File|FileUtils|Deno|Bun)\s*\[|\brequire\s*\(\s*[^'"`\s)]/;

/** Ejecución de código que no es un literal o que viene decodificado: opaco aunque no se vean rutas. */
const CODE_EVAL_NONLITERAL = /(?<![.\w$])(eval|exec|compile|Function|create_function|instance_eval|class_eval|module_eval)\s*\(\s*(?!['"`)])|\bnew\s+Function\s*\(\s*(?!['"`)])|\bvm\.(runIn\w*|Script|compileFunction)\b|\brunpy\b|\bimportlib\.import_module\s*\(\s*(?!['"])/;
const CODE_DECODE = /\b(fromCharCode|atob|b64decode|a85decode|b32decode|unhexlify|base64_decode|hex2bin|str_rot13|gzinflate|gzuncompress)\b|\bbytes\.fromhex\b|\bBuffer\.from\s*\([^)]*['"](base64|base64url|hex)['"]|\bdecode\s*\(\s*['"](base64|hex|rot13)/;

/** Marcas de interpolación: el literal no es una ruta definitiva. */
const CODE_INTERP_MARK = /\$\{|\$\w|\{[^}]*\}|%[sdr(]|#\{/;

const CONTROL_TAILS = new Set(['settings.json', 'settings.local.json', 'hooks', 'rules']);

/** Literales entre comillas del programa (comilla simple, doble o invertida; sin escapes anidados). */
function codeLiterals(code) {
  const outL = [];
  // Literales adyacentes concatenados ('.cl' + 'aude', "a" "b", 'a' . 'b'): se suman unidos.
  const joined = [];
  const JOIN = /((['"])[^'"\n]{0,400}\2)(\s*[+.]?\s*(['"])[^'"\n]{0,400}\4)+/g;
  for (const m of String(code).matchAll(JOIN)) {
    const parts = [...m[0].matchAll(/(['"])([^'"\n]{0,400})\1/g)].map((x) => x[2]);
    if (parts.length > 1) joined.push({ src: m[0], value: parts.join('') });
  }
  for (const j of joined) outL.push({ src: j.src, value: j.value.replace(/\\\\/g, '\\'), joined: true });
  for (const m of String(code).matchAll(/'([^'\n]{0,400})'|"([^"\n]{0,400})"|`([^`]{0,400})`/g)) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v === undefined || v === '') continue;
    // Modo de apertura de Perl ("> archivo", "+<archivo") y escapes de barra invertida duplicada.
    outL.push({ src: m[0], value: v.replace(/^\s*(\+?[<>]{1,2}|\|)\s*/, '').replace(/\\\\/g, '\\') });
  }
  return outL;
}

/**
 * Clasifica un literal frente a las rutas protegidas.
 * direct: es un control o está dentro de uno; doc: archivo con skip-worktree; claudeDir: el
 * directorio .claude (contiene los controles); ancestor: la raíz u otro ancestro; constructed:
 * fragmento con interpolación o pieza suelta que nombra un control; safe: ruta definida ajena.
 */
function classifyCodeLiteral(value, ctx) {
  const segs = P.norm(value).split('/').filter(Boolean);
  const res = new Set();
  // .claude/<control> en cualquier prefijo (otra raíz, home, interpolación) y CLAUDE.md por nombre.
  for (let k = 0; k + 1 < segs.length; k++) if (segs[k] === '.claude' && CONTROL_TAILS.has(segs[k + 1])) res.add('direct');
  if (segs[segs.length - 1] === 'claude.md') res.add('direct');
  const dynamic = CODE_INTERP_MARK.test(value);
  if (!dynamic && ctx.root) {
    for (const d of ctx.dirs || [ctx.cwd]) {
      const r = P.resolveFrom(d, value);
      const hit = P.protectedHit(ctx.root, r);
      if (hit) {
        if (P.isWithin(r, hit)) res.add('direct');
        else if (P.isWithin(r, P.resolveFrom(ctx.root, '.claude'))) res.add('claudeDir');
        else res.add('ancestor');
      }
      const doc = P.protectedDocHit(ctx.root, r);
      if (doc && P.isWithin(r, P.resolveFrom(ctx.root, doc))) res.add('doc');
    }
  }
  // ".claude" con interpolación, dentro de una cadena que no es una ruta simple, o como pieza suelta.
  if (/\.claude\b/i.test(value) && (dynamic || !segs.includes('.claude'))) res.add('constructed');
  return res.size ? res : new Set(['safe']);
}

/**
 * P0.2: código inline (node -e, python -c, perl -e, ruby -e, php -r, deno eval, heredoc/stdin)
 * que escribe sobre los controles (H-12) o sobre los originales con skip-worktree (H-10).
 * dynamic=true: el texto contiene expansiones del shell y sólo se conoce aproximado.
 */
function codeProtected(code, ctx, out, label, dynamic) {
  const text = String(code ?? '');
  const write = CODE_WRITE_API.test(text);
  const proc = CODE_PROC_API.test(text);
  const opaque = CODE_OPAQUE_API.test(text);
  const effect = write || proc || opaque;

  if (dynamic) {
    // El programa depende de expansiones del shell: su contenido real no es verificable.
    const residue = text.replace(/\$\{[^}]*\}|\$\([^)]*\)|\$\w+|`[^`]*`/g, '').replace(/[\s'";]/g, '');
    if (residue.length < 3) { out.d('H-13', `${label}: programa formado sólo por expansiones del shell, no verificable`); return; }
    if (effect) { out.d('H-13', `${label}: código dinámico con escritura, procesos o evaluación, no verificable`); return; }
  }
  // Evaluar código no literal o decodificado: puede hacer cualquier cosa, también sobre los controles.
  if (CODE_EVAL_NONLITERAL.test(text) || (CODE_DECODE.test(text) && /(?<![.\w$])(eval|exec|Function|compile)\b|\bvm\./.test(text))) {
    out.d('H-13', `${label}: evalúa código armado o decodificado en tiempo de ejecución, no verificable`); return;
  }
  if (!effect) return; // sin señales de escritura: lecturas y código ajeno a los controles pasan.

  const lits = codeLiterals(text);
  const kinds = new Set();
  let rest = text;
  for (const l of lits) {
    const k = classifyCodeLiteral(l.value, ctx);
    for (const x of k) kinds.add(x);
    if (k.has('safe')) rest = rest.split(l.src).join(' ');
  }
  // Menciones de .claude / CLAUDE.md fuera de literales con ruta definida (concatenaciones, f-strings).
  const mention = /\.claude\b|claude\.md/i.test(rest);

  if (kinds.has('direct')) { out.d('H-12', `${label}: código que escribe, lanza procesos o evalúa código y referencia un control protegido`); return; }
  if (kinds.has('doc')) { out.d('H-10', `${label}: código que escribe y referencia un archivo protegido por skip-worktree`); return; }
  if (kinds.has('claudeDir') || kinds.has('constructed') || mention) {
    out.d('H-12', `${label}: ruta construida hacia .claude/ junto con escritura, procesos o evaluación: destino no verificable`); return;
  }
  if (kinds.has('ancestor') && CODE_DESTRUCTIVE_API.test(text)) {
    out.d('H-12', `${label}: borrado o movimiento sobre un directorio que contiene los controles`); return;
  }
  if (ctx.dirsDynamic && write && lits.some((l) => !/^([a-zA-Z]:)?[\\/]/.test(l.value) && /[./\\]/.test(l.value))) {
    out.d('H-12', `${label}: cd dinámico + escritura con rutas relativas: destino no verificable`);
  }
}

function dataScripts(name, words, cmd, ctx, out) {
  if (READONLY.has(name) || name === 'git' || name === 'code') return;
  const tokens = [];
  for (const w of words) {
    const v = w.text ?? w.approx;
    for (const piece of String(v).split(/\s+/)) if (piece) tokens.push(piece);
  }
  for (const tk of tokens) {
    const clean = tk.replace(/^['"]|['"]$/g, '');
    const base = progName(clean).replace(/\.py$/, '');
    const isModule = /^[\w.]+$/.test(clean) && clean.includes('.') && !/\.py$/.test(clean);
    const modTail = isModule ? clean.split('.').pop() : null;
    for (const s of DATA_SCRIPTS) {
      if (base === s || modTail === s) { out.d('H-06', `script de datos bloqueado: ${s}`); return; }
    }
    for (const s of [base, modTail]) {
      if (s && SEED_RE.test(s)) { out.d('H-06', `script de datos bloqueado: ${s}`); return; }
    }
    if (base === 'start' && /start\.sh$/i.test(clean)) startSh(ctx, out);
  }
}

/**
 * Índices de argumentos que son patrones de EXCLUSIÓN (no rutas a leer): --exclude=.env*,
 * --exclude-dir secrets, rg -g '!*.pem', gci -Exclude .env*. Las inclusiones sí se revisan.
 */
function exclusionValueIndexes(name, args) {
  const skip = new Set();
  if (!['grep', 'egrep', 'fgrep', 'rg', 'get-childitem', 'select-string'].includes(name)) return skip;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (t === null) continue;
    if (/^--exclude(-dir|-from)?=/.test(t)) { skip.add(k); continue; }
    if (/^--exclude(-dir|-from)?$/.test(t)) { skip.add(k); skip.add(k + 1); k++; continue; }
    if ((t === '-g' || t === '--glob' || t === '--iglob') && (args[k + 1]?.text ?? '').startsWith('!')) { skip.add(k + 1); k++; continue; }
    if (/^-(exclude|ex)$/i.test(t)) { skip.add(k); skip.add(k + 1); k++; continue; }
    if (args[k].param && /^-(exclude|ex)/i.test(t)) skip.add(k);
  }
  return skip;
}

// ---------------- rutas: sensibles y autoprotección ----------------
function wordPaths(w) {
  const v = w.text ?? w.approx;
  if (v == null || v === '') return [];
  if (/^--?[\w-]+=/.test(v)) return [v.slice(v.indexOf('=') + 1)];
  return [v];
}

function checkPathWord(w, ctx, out, { write, program, redirect }) {
  for (const v of wordPaths(w)) {
    for (const d of ctx.dirs || [ctx.cwd]) {
      const resolved = P.resolveFrom(d, v);
      const why = P.sensitiveReason(v, resolved);
      if (why) {
        if (!write && METADATA_ONLY.has(program)) continue;
        out.d('SEC', `acceso a archivo sensible (${why})`);
        return;
      }
    }
    if (w.glob && w.text !== null) {
      const g = P.globSensitive(ctx.cwd, w.text, { dot: ctx.shell === 'ps' });
      if (g && !METADATA_ONLY.has(program)) { out.d('SEC', `comodín que alcanza archivos sensibles (${g})`); return; }
    }
  }
  if (redirect && write) {
    // PowerShell: `$null` es una variable automática constante (no se puede reasignar ni redefinir);
    // redirigir a ella descarta la salida y no escribe en disco. Sólo la forma exacta `$null`:
    // `$global:null`, `${null}` o cualquier otra variable siguen siendo destinos dinámicos.
    if (w.text === null && ctx.shell === 'ps' && /^\$null$/i.test(w.raw ?? '')) return;
    if (w.text === null) { out.d('H-12', 'redirección de escritura a un destino dinámico'); return; }
    for (const d of ctx.dirs || [ctx.cwd]) {
      const hit = P.protectedHit(ctx.root, P.resolveFrom(d, w.text));
      if (hit) { out.d('H-12', `escritura sobre un control protegido (${path.basename(hit)})`); return; }
      const doc = P.protectedDocHit(ctx.root, P.resolveFrom(d, w.text));
      if (doc) { out.d('H-10', `escritura sobre un archivo protegido por skip-worktree (${doc})`); return; }
    }
  }
}

// ssh: opciones que llevan valor (OpenSSH 9.x). El valor sigue siendo una ruta local (p. ej. -E log, -F config).
const SSH_OPT_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));
const SSH_LOCAL_HOSTS = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|0\.0\.0\.0)$/i;

/**
 * H-12 (falso positivo de rutas remotas): en `ssh [opciones] destino [comando remoto...]`, el comando
 * remoto se ejecuta en el otro host y sus palabras no son rutas de esta máquina. Devuelve los índices
 * de `args` que forman el comando remoto, o un conjunto vacío si no se puede delimitar con certeza
 * (argumento dinámico antes del destino) o si el destino es esta misma máquina.
 * Las opciones y sus valores se siguen verificando como rutas locales. SEC no cambia: una ruta remota
 * sensible (.env, secrets, .ssh) sigue bloqueada. ssh sigue sujeto a la regla ask de settings.json.
 */
export function sshRemoteArgs(args) {
  const none = new Set();
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i].text;
    if (t === null) return none;
    if (t === '--') { i++; break; }
    if (!t.startsWith('-') || t === '-') break;
    for (let k = 1; k < t.length; k++) {
      if (SSH_OPT_VALUE.has(t[k])) { if (k === t.length - 1) i++; break; }
    }
  }
  const dest = args[i]?.text;
  if (dest == null) return none;
  let host = dest.replace(/^[^@]*@/, '');
  if (/^ssh:\/\//i.test(dest)) host = dest.slice(6).replace(/^[^@/]*@/, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (SSH_LOCAL_HOSTS.test(host)) return none;
  const remote = new Set();
  for (let k = i + 1; k < args.length; k++) remote.add(k);
  return remote;
}

function protectedWrite(name, args, ctx, out) {
  if (READONLY.has(name) || name === 'git' || name === 'node' && args.some((w) => w.text === '--test')) return;
  // cd no escribe; las escrituras relativas que siguen se verifican desde todos los directorios candidatos (R-31).
  if (CD_PROGS.has(name)) return;
  // AG-20: parado dentro de .claude/ (fuera de los worktrees), un programa que no es de sólo lectura
  // puede escribir con nombre implícito (tar -x, curl -O, npm init): se bloquea sin mirar argumentos.
  if (ctx.root) {
    const claudeDir = P.resolveFrom(ctx.root, '.claude');
    const worktrees = P.resolveFrom(ctx.root, '.claude/worktrees');
    for (const d of ctx.dirs || [ctx.cwd]) {
      const r = P.resolveFrom(d, '.');
      if (P.isWithin(r, claudeDir) && !P.isWithin(r, worktrees)) {
        out.d('H-12', `${name} ejecutado dentro de .claude/ puede escribir sobre los controles`);
        return;
      }
    }
  }
  const remote = name === 'ssh' ? sshRemoteArgs(args) : new Set();
  for (const [k, w] of args.entries()) {
    if (remote.has(k)) continue;
    if (w.text === null) {
      if (WRITE_PROGS.has(name)) { out.d('H-12', `${name} con destino dinámico no verificable`); return; }
      continue;
    }
    const vals = wordPaths(w);
    // ssh -E/-F/-S... con el valor pegado (-E.claude/settings.json): se verifica también el valor.
    if (name === 'ssh') { const m = /^-[A-Za-z]*?[BbcDEeFIiJLlmOoPpQRSWw](.+)$/.exec(w.text); if (m) vals.push(m[1]); }
    for (const v of vals) {
      if (v.startsWith('-') && !v.includes('/') && !v.includes('\\')) continue;
      if (!path.isAbsolute(v) && ctx.dirsDynamic && WRITE_PROGS.has(name)) { out.d('H-12', 'cd dinámico + escritura relativa: destino no verificable'); return; }
      for (const d of ctx.dirs || [ctx.cwd]) {
        const r = P.resolveFrom(d, v);
        const hit = P.protectedHit(ctx.root, r);
        if (hit) { out.d('H-12', `${name} sobre un control protegido (${path.basename(hit)})`); return; }
        const doc = P.protectedDocHit(ctx.root, r);
        if (doc && WRITE_PROGS.has(name)) { out.d('H-10', `${name} sobre un archivo protegido por skip-worktree (${doc})`); return; }
      }
    }
  }
}

// ---------------- D-5 búsquedas recursivas ----------------
function recursiveSearch(name, args, ctx, out) {
  const g = { recursive: false, excludes: [], excludeDirs: [], includes: [], roots: [], noIgnore: false };
  if (['grep', 'egrep', 'fgrep'].includes(name)) {
    let patternGiven = false;
    const pos = [];
    for (let i = 0; i < args.length; i++) {
      const t = args[i].text;
      if (t === null) { pos.push(null); continue; }
      const val = () => { const v = t.includes('=') ? t.slice(t.indexOf('=') + 1) : args[++i]?.text; return v; };
      if (t === '--') { pos.push(...args.slice(i + 1).map((w) => w.text)); break; }
      if (/^--(recursive|dereference-recursive)$/.test(t) || /^--directories=recurse$/.test(t)) { g.recursive = true; continue; }
      if (t.startsWith('--exclude-dir')) { g.excludeDirs.push(val()); continue; }
      if (t.startsWith('--exclude-from')) { val(); g.excludes.push('<from-file>'); continue; }
      if (t.startsWith('--exclude')) { g.excludes.push(val()); continue; }
      if (t.startsWith('--include')) { g.includes.push(val()); continue; }
      if (t === '-e' || t === '-f' || t.startsWith('--regexp') || t.startsWith('--file')) { val(); patternGiven = true; continue; }
      if (['-m', '-A', '-B', '-C', '-D', '--max-count', '--context', '--label', '--color'].includes(t)) { if (t !== '--color') i++; continue; }
      if (t === '-d' || t === '--directories') { if (args[i + 1]?.text === 'recurse') g.recursive = true; i++; continue; }
      if (/^-[a-zA-Z]+$/.test(t)) { if (/[rR]/.test(t)) g.recursive = true; continue; }
      if (t.startsWith('-')) continue;
      pos.push(t);
    }
    if (!g.recursive) return;
    g.roots = (patternGiven ? pos : pos.slice(1));
    if (!g.roots.length) g.roots = ['.'];
  } else if (name === 'rg') {
    for (let i = 0; i < args.length; i++) {
      const t = args[i].text;
      if (t === null) continue;
      if (/^--no-ignore/.test(t) || /^-[a-zA-Z]*u/.test(t)) g.noIgnore = true;
      if (t === '-g' || t === '--glob' || t === '--iglob') { const v = args[++i]?.text || ''; if (v.startsWith('!')) { g.excludes.push(v.slice(1)); g.excludeDirs.push(v.slice(1).replace(/\/\*\*$|\/$/, '')); } else g.includes.push(v); }
    }
    if (!g.noIgnore) return; // rg respeta .gitignore: los .env*, secrets y *.pem del repo están ignorados.
    g.recursive = true;
    const pos = args.filter((w) => w.text && !w.text.startsWith('-')).map((w) => w.text);
    g.roots = pos.slice(1);
    if (!g.roots.length) g.roots = ['.'];
  } else if (name === 'git' ) {
    return;
  } else if (name === 'findstr') {
    if (!args.some((w) => w.text && /^\/s$/i.test(w.text))) return;
    g.recursive = true;
    g.roots = ['.'];
  } else return;

  for (const r of g.roots) {
    if (r === null) { out.d('D-5', 'búsqueda recursiva sobre una raíz dinámica'); return; }
    const root = P.resolveFrom(ctx.cwd, r);
    const { files, truncated } = P.findSensitiveUnder(root.replace(/^([a-z]):/, (m, l) => `${l.toUpperCase()}:`));
    const covered = (f) => {
      const base = f.replace(/\/$/, '').split('/').pop();
      const isDir = f.endsWith('/');
      if (!isDir && g.includes.length && !g.includes.some((p) => P.fnmatch(p, base))) return true;
      if (!isDir && g.excludes.some((p) => p && P.fnmatch(p, base))) return true;
      const segs = f.replace(/\/$/, '').split('/');
      if (g.excludeDirs.some((p) => p && segs.some((s, k) => (k < segs.length - 1 || isDir) && P.fnmatch(p, s)))) return true;
      return false;
    };
    const probe = truncated ? ['.env', '.env.local', 'x.pem', 'x.key', 'backend/secrets/'] : files;
    const leak = probe.filter((f) => !covered(f));
    if (leak.length) {
      out.d('D-5', `búsqueda recursiva que puede leer archivos sensibles (${truncated ? 'raíz demasiado grande' : leak.slice(0, 3).join(', ')}); excluilos (--exclude=.env* --exclude=*.pem --exclude=*.key --exclude-dir=secrets) o usá la herramienta Grep`);
      return;
    }
  }
}

function psRecursiveReads(commands, ctx, out) {
  for (const c of commands) {
    const n0 = c.words[0]?.text; if (!n0) continue;
    const nm = PS_ALIASES[progName(n0)] ?? progName(n0);
    if (!['select-string', 'get-content'].includes(nm) || c.stdin.kind !== 'dynamic') continue;
    const prev = commands.find((x) => x.source === c.stdin.text);
    if (!prev) continue;
    const pn = PS_ALIASES[progName(prev.words[0]?.text || '')] ?? progName(prev.words[0]?.text || '');
    if (pn !== 'get-childitem') continue;
    const ws = prev.words.slice(1);
    if (!ws.some((w) => w.text && /^-r(e|ec|ecu|ecur|ecurs|ecurse)?$/i.test(w.text))) continue;
    const g = { excludes: [], includes: [], roots: [] };
    for (let i = 0; i < ws.length; i++) {
      const t = (ws[i].text || '').toLowerCase();
      const val = ws[i].argument ?? (ws[i].param ? ws[++i] : null);
      const vals = val ? (val.items ? val.items.map((x) => x.text) : [val.text]) : [];
      if (/^-(exclude|ex)/.test(t)) g.excludes.push(...vals);
      else if (/^-(include|filter|fi)/.test(t)) g.includes.push(...vals);
      else if (/^-(path|literalpath|lp|pspath)/.test(t)) g.roots.push(...vals);
      else if (!t.startsWith('-')) g.roots.push(ws[i].text);
    }
    if (!g.roots.length) g.roots = ['.'];
    for (const r of g.roots) {
      if (r === null) { out.d('D-5', 'búsqueda recursiva sobre una raíz dinámica'); return; }
      const { files, truncated } = P.findSensitiveUnder(P.resolveFrom(ctx.cwd, r));
      const probe = truncated ? ['.env', '.env.local', 'x.pem', 'x.key', 'backend/secrets/'] : files;
      const leak = probe.filter((f) => {
        if (f.endsWith('/')) return true; // gci -Recurse -Exclude no evita recorrer el directorio
        const base = f.replace(/\/$/, '').split('/').pop();
        if (g.includes.length && !g.includes.some((p) => p && P.fnmatch(p, base))) return false;
        return !g.excludes.some((p) => p && P.fnmatch(p, base));
      });
      if (leak.length) { out.d('D-5', 'Get-ChildItem -Recurse leído por contenido alcanza archivos sensibles; usá -Exclude o la herramienta Grep'); return; }
    }
  }
}

// ---------------- git ----------------
async function gitPolicy(args, ctx, out, w0, depth) {
  if (depth > 5) { out.d('H-11', 'cadena de alias de git demasiado profunda'); return; }
  let i = 0;
  let gitCwd = ctx.cwd;
  let globals = false;
  for (; i < args.length; i++) {
    const t = args[i].text;
    if (t === null) { out.d('H-13', 'opción global de git dinámica'); return; }
    if (!t.startsWith('-')) break;
    globals = true;
    if (t === '-C') { const v = args[++i]?.text; if (v == null) { out.d('H-13', 'git -C dinámico'); return; } gitCwd = P.resolveFrom(gitCwd, v); continue; }
    if (t === '-c' || t.startsWith('--config-env')) {
      const kv = t === '-c' ? args[++i]?.text : (t.includes('=') ? t.slice(t.indexOf('=') + 1) : args[++i]?.text);
      if (kv == null) { out.d('H-11', 'git -c dinámico'); return; }
      const key = kv.split('=')[0];
      if (!SAFE_GIT_C_KEYS.test(key) && !SAFE_GIT_C_KEYS.test(kv)) { out.d('H-11', `git -c ${key}: configuración inline no permitida (puede ocultar alias o comandos)`); return; }
      continue;
    }
    if (['--git-dir', '--work-tree', '--namespace', '--super-prefix'].includes(t)) { i++; continue; }
    if (t === '--version' || t === '--help' || t === '-h') return;
  }
  const subW = args[i];
  if (!subW) return;
  if (subW.text === null) { out.d('H-13', 'subcomando de git dinámico'); return; }
  const sub = subW.text;
  const rest = args.slice(i + 1);
  const canonical = ctx.canonical && !globals && isBare(subW) && isBare(w0);
  const gctx = { ...ctx, gitCwd };

  // AG-20: send-pack publica refs como un push, sin pasar por la confirmación de `git push`.
  if (sub === 'send-pack') { out.d('H-01', 'git send-pack publica refs como un push sin confirmación'); return; }

  if (!GIT_BUILTINS.has(sub)) {
    let alias = null;
    try { alias = git(['config', '--get', `alias.${sub}`], gitCwd).trim(); } catch { alias = null; }
    if (alias) {
      if (alias.startsWith('!')) {
        const line = alias.slice(1) + ' ' + rest.map((w) => w.raw).join(' ');
        return nested(line, 'bash', ctx, out, `alias git ${sub}`);
      }
      const toks = alias.split(/\s+/).filter(Boolean).map((t) => ({ text: t, raw: t, approx: t, quoted: true, glob: false }));
      return gitPolicy([...toks, ...rest], { ...ctx, canonical: false }, out, w0, depth + 1);
    }
    return;
  }

  ownerAllowGuard(sub, rest, out, gctx);
  const deniedBefore = out.deny.length;
  gitSecretGuard(sub, rest, ctx, gitCwd, out);
  if (out.deny.length > deniedBefore) return;

  switch (sub) {
    case 'push': return gitPush(rest, canonical, out);
    case 'reset':
      if (rest.some((w) => w.text === null)) { out.d('H-02', 'git reset con argumentos dinámicos'); return; }
      for (const w of rest) {
        if (w.text === '--' || w.text === '--end-of-options') break;
        if (!w.text.startsWith('--')) continue;
        const { names, negated } = resolveLongOpt(w.text, RESET_LONG);
        if (!names.length) { out.d('H-02', `git reset con opción desconocida (${w.text.split('=')[0]}): no se puede descartar --hard`); return; }
        if (!negated && names.includes('hard')) { out.d('H-02', `git reset --hard está bloqueado (${w.text.split('=')[0]})`); return; }
      }
      return;
    case 'clean': return gitClean(rest, gctx, out);
    case 'update-index': return gitUpdateIndex(rest, gctx, out);
    case 'config': return gitConfig(rest, out);
    case 'checkout': return gitCheckout(rest, gctx, out);
    case 'switch': return gitSwitch(rest, gctx, out);
    case 'restore': {
      if (rest.some((w) => w.text === null)) { out.d('H-12', 'git restore con rutas dinámicas'); return; }
      const staged = rest.some((w) => w.text === '--staged' || w.text === '-S');
      const wt = rest.some((w) => w.text === '--worktree' || w.text === '-W');
      if (staged && !wt) return;
      return gitPathsGuard(rest.filter((w) => !w.text.startsWith('-')).map((w) => w.text), gctx, out, 'git restore');
    }
    case 'rm':
    case 'mv': {
      if (rest.some((w) => w.text === null)) { out.d('H-12', `git ${sub} con rutas dinámicas`); return; }
      if (sub === 'rm' && rest.some((w) => w.text === '--cached')) return;
      return gitPathsGuard(rest.filter((w) => !w.text.startsWith('-')).map((w) => w.text), gctx, out, `git ${sub}`);
    }
    case 'stash': return gitStash(rest, gctx, out);
    default:
      return;
  }
}

/**
 * AG-20 (SEC): los argumentos de git también pasan por la regla de archivos sensibles. Evita leer
 * secretos con `git diff --no-index NUL backend/.env`, `git add -f backend/.env` + `git show :ruta`,
 * `git hash-object`, etc. También revisa la ruta de `<rev>:<ruta>`. status, ls-files y check-ignore
 * sólo muestran nombres.
 */
function gitSecretGuard(sub, rest, ctx, gitCwd, out) {
  if (['status', 'ls-files', 'check-ignore'].includes(sub)) return;
  const c = gitCwd === ctx.cwd ? ctx : { ...ctx, cwd: gitCwd, dirs: [gitCwd] };
  const before = out.deny.length;
  for (const w of rest) {
    if (w.text === null) continue;
    checkPathWord(w, c, out, { write: false, program: 'git' });
    const m = /^[^:/\\\s]*:(.+)$/.exec(w.text);
    if (m && !/^[a-z][a-z+.-]*:\/\//i.test(w.text)) {
      checkPathWord({ ...w, text: m[1], raw: m[1], approx: m[1], glob: false }, c, out, { write: false, program: 'git' });
    }
    if (out.deny.length > before) return;
  }
}

// ---------------- D-9: guarda de la allowlist OWNER ----------------
// settings.json permite sin diálogo algunos subcomandos de git con comodín (`git diff *`, `git branch *`...).
// Un comodín no distingue opciones que escriben o descartan; el hook sí: para esas variantes emite "ask",
// que prevalece sobre el allow de settings. Sólo agrega confirmaciones: nunca convierte un bloqueo en
// permiso ni quita una confirmación existente.
const RESTORE_LONG = ['source', 'patch', 'worktree', 'staged', 'quiet', 'progress', 'ours', 'theirs', 'merge', 'conflict',
  'ignore-unmerged', 'ignore-skip-worktree-bits', 'recurse-submodules', 'overlay', 'pathspec-from-file', 'pathspec-file-nul'];
const SWITCH_LONG = ['create', 'force-create', 'detach', 'guess', 'ignore-other-worktrees', 'force', 'discard-changes', 'merge',
  'conflict', 'quiet', 'progress', 'track', 'orphan', 'recurse-submodules'];
const LS_REMOTE_LONG = ['branches', 'heads', 'tags', 'refs', 'quiet', 'upload-pack', 'exit-code', 'get-url', 'symref', 'sort', 'server-option'];
// git branch sólo de consulta: cualquier otra opción (borrar, mover, copiar, forzar, upstream) pide confirmación.
const BRANCH_READ_SHORT = new Set(['a', 'r', 'v', 'l', 'i']);
const BRANCH_READ_LONG = ['all', 'remotes', 'verbose', 'list', 'show-current', 'contains', 'no-contains', 'merged', 'no-merged',
  'points-at', 'sort', 'format', 'color', 'no-color', 'column', 'no-column', 'abbrev', 'no-abbrev', 'ignore-case', 'omit-empty'];
const BRANCH_READ_VALUE = new Set(['contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'sort', 'format']);

// AG-16 (2026-11-14): las variantes locales de git (restore, switch -f, branch -D, --output, --ext-diff,
// --no-index, ls-remote) ya no piden confirmación. Queda sólo el bloqueo de --output sobre controles o
// documentos skip-worktree. El resto de esta función se conserva sin uso para no reescribir el módulo.
function ownerAllowGuard(sub, rest, out, gctx) {
  if (!['diff', 'log', 'show'].includes(sub)) return;
  if (rest.some((w) => w.text === null)) { out.d('H-12', `git ${sub} con argumentos dinámicos: no se puede descartar --output sobre un control`); return; }
  const ask = () => {};
  const opts = [];
  for (const w of rest) { if (w.text === '--' || w.text === '--end-of-options') break; opts.push(w.text); }

  if (['diff', 'log', 'show'].includes(sub)) {
    // --output=<archivo> (o cualquier prefijo no ambiguo, p. ej. --outp) escribe un archivo local.
    const oi = opts.findIndex((t) => /^--ou(t(p(u(t)?)?)?)?(=|$)/i.test(t));
    if (oi >= 0) {
      // Destino sobre un control protegido o un documento skip-worktree: bloqueo, no confirmación.
      const t = opts[oi];
      const target = t.includes('=') ? t.slice(t.indexOf('=') + 1) : opts[oi + 1];
      if (target != null && gctx) {
        const r = P.resolveFrom(gctx.gitCwd || gctx.cwd, target);
        const hit = P.protectedHit(gctx.root, r);
        if (hit) { out.d('H-12', `git ${sub} --output sobre un control protegido (${path.basename(hit)})`); return; }
        const doc = P.protectedDocHit(gctx.root, r);
        if (doc) { out.d('H-10', `git ${sub} --output sobre un archivo protegido por skip-worktree (${doc})`); return; }
      }
      return ask(`git ${sub} --output escribe un archivo`);
    }
    if (opts.some((t) => /^--ext-d(i(f(f)?)?)?$/i.test(t))) return ask(`git ${sub} --ext-diff ejecuta un programa externo`);
    if (sub === 'diff' && opts.some((t) => /^--no-i(n(d(e(x)?)?)?)?$/i.test(t))) return ask('git diff --no-index lee archivos fuera del repositorio');
    return;
  }
  if (sub === 'restore') {
    let staged = false, worktree = false;
    for (const t of opts) {
      if (t.startsWith('--')) {
        const { names, negated } = resolveLongOpt(t, RESTORE_LONG);
        if (names.length !== 1) return ask(`git restore con opción ${names.length ? 'ambigua' : 'desconocida'} (${t.split('=')[0]})`);
        if (!negated && names[0] === 'staged') staged = true;
        if (!negated && names[0] === 'worktree') worktree = true;
      } else if (/^-[a-zA-Z]+$/.test(t)) {
        if (t.includes('S')) staged = true;
        if (t.includes('W')) worktree = true;
      }
    }
    if (!staged || worktree) return ask('git restore sobre el árbol de trabajo descarta cambios');
    return;
  }
  if (sub === 'switch') {
    for (const t of opts) {
      if (t.startsWith('--')) {
        const { names, negated } = resolveLongOpt(t, SWITCH_LONG);
        if (names.length !== 1) return ask(`git switch con opción ${names.length ? 'ambigua' : 'desconocida'} (${t.split('=')[0]})`);
        if (!negated && ['force', 'discard-changes', 'force-create'].includes(names[0])) return ask(`git switch --${names[0]} puede descartar cambios o commits`);
      } else if (/^-[a-zA-Z]+$/.test(t) && /[fC]/.test(t)) return ask(`git switch ${t} puede descartar cambios o commits`);
    }
    return;
  }
  if (sub === 'ls-remote') {
    for (const t of opts) {
      if (t.startsWith('--')) {
        const { names } = resolveLongOpt(t, LS_REMOTE_LONG);
        if (names.length !== 1) return ask(`git ls-remote con opción ${names.length ? 'ambigua' : 'desconocida'} (${t.split('=')[0]})`);
        if (names[0] === 'upload-pack') return ask('git ls-remote --upload-pack ejecuta un programa');
      } else if (/^-[a-zA-Z]+$/.test(t) && /[^htbq]/.test(t.slice(1))) return ask(`git ls-remote con opción corta no reconocida (${t})`);
    }
    return;
  }
  if (sub === 'branch') {
    let listMode = false;
    for (let i = 0; i < opts.length; i++) {
      const t = opts[i];
      if (t.startsWith('--')) {
        const { names, value } = resolveLongOpt(t, BRANCH_READ_LONG);
        if (names.length !== 1) return ask(`git branch ${t.split('=')[0]}: sólo las consultas se permiten sin confirmación`);
        if (names[0] === 'list') listMode = true;
        if (BRANCH_READ_VALUE.has(names[0]) && value === null && !['contains', 'no-contains', 'merged', 'no-merged', 'points-at'].includes(names[0])) i++;
        continue;
      }
      if (/^-[a-zA-Z]+$/.test(t)) {
        const flags = t.slice(1).split('');
        if (flags.some((f) => !BRANCH_READ_SHORT.has(f))) return ask(`git branch ${t}: sólo las consultas se permiten sin confirmación`);
        if (flags.includes('l')) listMode = true;
        continue;
      }
      // Argumento posicional: con --list es un patrón; sin --list puede ser un commit de --contains/--merged
      // o el nombre de una rama a crear. Sólo se acepta tras una opción de consulta que lo consume.
      const prev = opts[i - 1] ?? '';
      const consumedBy = /^--(no-)?(contains|merged)$|^--points-at$/i.test(prev);
      if (!listMode && !consumedBy) return ask('git branch con nombre de rama crea o modifica referencias');
    }
  }
}

// Opciones largas reconocidas (git 2.53). Git acepta cualquier prefijo no ambiguo de una opción
// larga, así que se resuelven contra estas listas en lugar de compararse en forma exacta.
const PUSH_LONG = ['all', 'branches', 'mirror', 'delete', 'tags', 'dry-run', 'porcelain', 'force', 'force-with-lease',
  'force-if-includes', 'repo', 'set-upstream', 'thin', 'receive-pack', 'exec', 'follow-tags', 'signed', 'atomic',
  'push-option', 'ipv4', 'ipv6', 'verbose', 'quiet', 'progress', 'prune', 'recurse-submodules', 'verify'];
const PUSH_VALUE = new Set(['repo', 'receive-pack', 'exec', 'push-option']);
const RESET_LONG = ['hard', 'soft', 'mixed', 'merge', 'keep', 'quiet', 'patch', 'intent-to-add', 'recurse-submodules',
  'pathspec-from-file', 'pathspec-file-nul', 'refresh'];
const CLEAN_LONG = ['dry-run', 'force', 'interactive', 'quiet', 'exclude'];

/**
 * Resuelve una opción larga ('--forc', '--no-verif=x') contra la lista de nombres conocidos, como
 * hace parse-options de git. Devuelve { names: [candidatos], negated, value }:
 *  - exacta o prefijo único -> un candidato;
 *  - prefijo ambiguo -> varios (git falla, pero se evalúan todos de forma conservadora);
 *  - desconocida -> ninguno.
 */
export function resolveLongOpt(t, known) {
  const eq = t.indexOf('=');
  let name = (eq >= 0 ? t.slice(2, eq) : t.slice(2)).toLowerCase();
  const value = eq >= 0 ? t.slice(eq + 1) : null;
  const match = (n) => (known.includes(n) ? [n] : known.filter((k) => k.startsWith(n)));
  let names = name ? match(name) : [];
  let negated = false;
  if (!names.length && name.startsWith('no-')) { names = match(name.slice(3)); negated = names.length > 0; }
  return { names, negated, value };
}

function gitPush(rest, canonical, out) {
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w.text === null) { out.d('H-01', 'git push con argumentos dinámicos: no se puede descartar un force push o un borrado'); return; }
    const t = w.text;
    if (t === '--' || t === '--end-of-options') { pos.push(...rest.slice(i + 1).map((x) => x.text)); break; }
    if (t.startsWith('--')) {
      const { names, negated, value } = resolveLongOpt(t, PUSH_LONG);
      if (!names.length) { out.d('H-01', `git push con opción desconocida (${t.split('=')[0]}): no se puede descartar un force push`); return; }
      if (!negated) {
        const force = names.find((n) => n.startsWith('force'));
        if (force) { out.d('H-01', `force push (${t.split('=')[0]} → --${force}) está bloqueado`); return; }
        const del = names.find((n) => ['delete', 'mirror', 'prune'].includes(n));
        if (del) { out.d('H-08', `git push ${t.split('=')[0]} (→ --${del}) borra o reescribe referencias remotas`); return; }
      }
      if (names.length === 1 && PUSH_VALUE.has(names[0]) && value === null && !negated) i++;
      continue;
    }
    if (/^-[a-zA-Z]+$/.test(t)) {
      if (t.includes('f')) { out.d('H-01', 'force push (-f) está bloqueado'); return; }
      if (t.includes('d')) { out.d('H-08', 'git push -d borra referencias remotas'); return; }
      if (t === '-o') i++;
      continue;
    }
    pos.push(t);
  }
  for (const ref of pos.slice(1)) {
    if (ref.startsWith('+')) { out.d('H-01', `refspec forzado (${ref}) está bloqueado`); return; }
    if (ref.startsWith(':')) { out.d('H-08', `refspec de borrado (${ref}) está bloqueado`); return; }
  }
  if (!canonical) out.d('H-07', 'git push en forma no canónica: escribilo como `git push ...` sin opciones globales para que pase por la confirmación');
}

function gitClean(rest, ctx, out) {
  let dry = false;
  const paths = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].text;
    if (t === null) { out.d('H-09', 'git clean con argumentos dinámicos'); return; }
    if (t === '--' || t === '--end-of-options') { paths.push(...rest.slice(i + 1).map((w) => w.text)); break; }
    if (t.startsWith('--')) {
      const { names, negated, value } = resolveLongOpt(t, CLEAN_LONG);
      if (names.length !== 1) { out.d('H-09', `git clean con opción ${names.length ? 'ambigua' : 'desconocida'} (${t.split('=')[0]})`); return; }
      if (names[0] === 'exclude' && value === null) i++;
      if (names[0] === 'dry-run' && !negated) dry = true;
      continue;
    }
    if (t === '-e') { i++; continue; }
    if (/^-[a-zA-Z]+$/.test(t)) {
      // Opciones cortas agrupadas: se lee carácter por carácter; -e consume el resto como valor.
      const flags = t.slice(1);
      const eIdx = flags.indexOf('e');
      const own = eIdx >= 0 ? flags.slice(0, eIdx) : flags;
      if (/[xX]/.test(own)) { out.d('H-09', 'git clean -x/-X borra archivos ignorados (.env*, docs/private)'); return; }
      if (/[^dfinq]/.test(own)) { out.d('H-09', `git clean con opción corta no reconocida (${t})`); return; }
      if (own.includes('n')) dry = true;
      if (eIdx >= 0 && eIdx === flags.length - 1) i++; // -e sin valor pegado: el valor es el siguiente argumento
      continue;
    }
    if (t.startsWith('-')) { out.d('H-09', `git clean con opción no reconocida (${t})`); return; }
    paths.push(t);
  }
  if (dry) return;
  gitPathsGuard(paths.length ? paths : ['.'], ctx, out, 'git clean');
}

function gitPathsGuard(paths, ctx, out, what) {
  for (const p of paths) {
    if (p === null) { out.d('H-12', `${what} con rutas dinámicas`); return; }
    const r = P.resolveFrom(ctx.gitCwd || ctx.cwd, p.replace(/^:\(?[^)]*\)?/, ''));
    const hit = P.protectedHit(ctx.root, r);
    if (hit) { out.d('H-12', `${what} alcanza un control protegido (${path.basename(hit)})`); return; }
    const doc = P.protectedDocHit(ctx.root, r);
    if (doc) { out.d('H-10', `${what} alcanza un archivo protegido por skip-worktree (${doc})`); return; }
  }
}

function gitUpdateIndex(rest, ctx, out) {
  const toggles = rest.some((w) => w.text === '--skip-worktree' || w.text === '--no-skip-worktree');
  if (!toggles) return;
  if (rest.some((w) => w.text === null || w.text === '--stdin' || w.text === '-z' || /[*?[]/.test(w.text))) { out.d('H-10', 'git update-index --(no-)skip-worktree con rutas no verificables'); return; }
  for (const w of rest) {
    if (w.text.startsWith('-')) continue;
    const doc = P.protectedDocHit(ctx.root, P.resolveFrom(ctx.gitCwd || ctx.cwd, w.text));
    if (doc) { out.d('H-10', `manipular skip-worktree de ${doc} está bloqueado`); return; }
  }
}

function gitConfig(rest, out) {
  if (rest.some((w) => w.text === null)) { out.d('H-11', 'git config con argumentos dinámicos'); return; }
  const t = rest.map((w) => w.text);
  const touches = t.some((x) => /^(alias|include|includeif)(\.|$)/i.test(x)) || t.includes('--edit') || t.includes('-e') || t.includes('edit');
  if (!touches) return;
  const readFlags = ['--get', '--get-all', '--get-regexp', '-l', '--list', '--get-urlmatch'];
  const newSyntaxRead = ['get', 'list'].includes(t.find((x) => !x.startsWith('-')));
  if (t.some((x) => readFlags.includes(x)) || newSyntaxRead) {
    if (!t.includes('--edit') && !t.includes('-e')) return;
  }
  out.d('H-11', 'modificar alias/include de git o editar la config está bloqueado');
}

function refHasControls(ref, cwd) {
  if (!gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)) return false;
  return gitOk(['cat-file', '-e', `${ref}:.claude/settings.json`], cwd) && gitOk(['cat-file', '-e', `${ref}:.claude/hooks/guard.mjs`], cwd);
}

function gitCheckout(rest, ctx, out) {
  if (rest.some((w) => w.text === null)) { out.d('H-12', 'git checkout con argumentos dinámicos'); return; }
  const before = [], after = [];
  let sep = false, newBranch = false, orphan = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].text;
    if (sep) { after.push(t); continue; }
    if (t === '--') { sep = true; continue; }
    if (['-b', '-B'].includes(t)) { newBranch = true; i++; continue; }
    if (t === '--orphan') { orphan = true; i++; continue; }
    if (t.startsWith('--pathspec-from-file')) { out.d('H-12', 'git checkout --pathspec-from-file no verificable'); return; }
    if (['--conflict'].includes(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    before.push(t);
  }
  if (orphan) return;
  if (newBranch) {
    if (before[0]) { const ref = before[0] === '-' ? '@{-1}' : before[0]; if (!refHasControls(ref, ctx.gitCwd)) out.d('H-12', `la referencia ${before[0]} no tiene los controles (.claude/settings.json + hooks)`); }
    return;
  }
  let paths = after;
  if (before.length) {
    const cand = before[0] === '-' ? '@{-1}' : before[0];
    const isRef = gitOk(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`], ctx.gitCwd);
    if (isRef) {
      const more = before.slice(1).concat(after);
      if (!more.length && !sep) {
        if (!refHasControls(cand, ctx.gitCwd)) out.d('H-12', `cambiar a ${before[0]} apagaría los controles: esa referencia no tiene .claude/settings.json + hooks`);
        return;
      }
      paths = more;
    } else paths = before.concat(after);
  }
  gitPathsGuard(paths, ctx, out, 'git checkout');
}

function gitSwitch(rest, ctx, out) {
  if (rest.some((w) => w.text === null)) { out.d('H-12', 'git switch con argumentos dinámicos'); return; }
  const pos = []; // con -c NEW, NEW se saltea y pos[0] es el punto de partida (si lo hay)
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].text;
    if (['-c', '-C', '--create', '--force-create'].includes(t)) { i++; continue; }
    if (t === '--orphan') { out.d('H-12', 'git switch --orphan vacía el árbol de trabajo y apaga los controles'); return; }
    if (t.startsWith('-') && t !== '-') continue;
    pos.push(t);
  }
  if (!pos.length) return;
  const ref = pos[0] === '-' ? '@{-1}' : pos[0];
  if (!refHasControls(ref, ctx.gitCwd)) out.d('H-12', `cambiar a ${pos[0]} apagaría los controles: esa referencia no tiene .claude/settings.json + hooks`);
}

function gitStash(rest, ctx, out) {
  if (rest.some((w) => w.text === null)) { out.d('H-12', 'git stash con argumentos dinámicos'); return; }
  const t = rest.map((w) => w.text);
  const sub = t[0] && !t[0].startsWith('-') ? t[0] : 'push';
  if (!['push', 'save'].includes(sub)) return;
  const untracked = t.some((x) => ['-u', '--include-untracked', '-a', '--all'].includes(x));
  const sepIdx = t.indexOf('--');
  const pathspec = sepIdx >= 0 ? t.slice(sepIdx + 1) : (sub === 'push' ? t.slice(t[0] === 'push' ? 1 : 0).filter((x) => !x.startsWith('-')) : []);
  if (pathspec.length) return gitPathsGuard(pathspec, ctx, out, 'git stash');
  let status = '';
  try {
    status = git(['status', '--porcelain', '--untracked-files=all', '--', ...P.PROTECTED_REL.filter((p) => !p.startsWith('.git/'))], ctx.root);
  } catch { out.d('H-12', 'no se pudo verificar el estado de los controles antes de git stash'); return; }
  const lines = status.split('\n').filter(Boolean).filter((l) => untracked || !l.startsWith('??'));
  if (lines.length) out.d('H-12', 'git stash retiraría cambios de los controles protegidos');
}

// ---------------- docker ----------------
async function dockerPolicy(name, args, ctx, out, w0) {
  let i = 0;
  const first = lit(args[0]);
  let remote = false;
  if (name === 'docker') {
    for (; i < args.length; i++) {
      const t = args[i].text;
      if (t === null) { out.d('H-13', 'opción global de docker dinámica'); return; }
      if (!t.startsWith('-')) break;
      if (['-H', '--host', '--context', '-c'].includes(t.split('=')[0])) remote = true;
      if (['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey'].includes(t) ) i++;
    }
  }
  const subW = name === 'docker-compose' ? { text: 'compose' } : args[i];
  const sub = subW?.text;
  if (sub === undefined) return;
  if (sub === null) { out.d('H-13', 'subcomando de docker dinámico'); return; }
  const rest = name === 'docker-compose' ? args : args.slice(i + 1);
  if (rest.some((w) => w.text === null) && ['volume', 'system', 'compose'].includes(sub)) {
    out.d('H-03', `docker ${sub} con argumentos dinámicos no verificable`); return;
  }
  const rt = rest.map((w) => w.text);

  const askCanon = ctx.canonical && isBare(w0) && name === 'docker' && ['compose', '-H', '--context'].includes(first);
  // AG-16: docker compose local ya no pide confirmación; sólo docker remoto (-H/--context) debe ser canónico.
  if (remote && !askCanon) out.d('H-07', 'docker -H / --context en forma no canónica: escribilo como `docker -H ...` o `docker --context ...`');

  if (sub === 'volume' && ['rm', 'remove', 'prune'].includes(rt[0])) { out.d('H-03', `docker volume ${rt[0]} está bloqueado`); return; }
  if (sub === 'system' && rt[0] === 'prune' && rt.includes('--volumes')) { out.d('H-03', 'docker system prune --volumes está bloqueado'); return; }
  if (sub === 'compose') {
    let j = 0;
    const valOpts = new Set(['-f', '--file', '-p', '--project-name', '--project-directory', '--profile', '--env-file', '--ansi', '--progress', '--parallel']);
    for (; j < rt.length; j++) { if (!rt[j].startsWith('-')) break; if (valOpts.has(rt[j])) j++; }
    const cs = rt[j];
    const ca = rt.slice(j + 1);
    if ((cs === 'down' || cs === 'rm') && ca.some((x) => x === '-v' || x === '--volumes' || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(x))) { out.d('H-03', `docker compose ${cs} -v borra volúmenes`); return; }
    if (cs === 'exec' || cs === 'run') await dockerNested(rest.slice(j + 1), ctx, out);
  }
  if (sub === 'exec' || sub === 'run') await dockerNested(rest, ctx, out);
}

async function dockerNested(ws, ctx, out) {
  const valOpts = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--name', '-v', '--volume', '-p', '--publish', '--entrypoint', '--network', '--mount', '-l', '--label', '-m', '--memory', '--platform', '--pull', '--restart', '--hostname', '-h']);
  let i = 0;
  while (i < ws.length && ws[i].text && ws[i].text.startsWith('-')) i += valOpts.has(ws[i].text) ? 2 : 1;
  const argv = ws.slice(i + 1); // salta contenedor/servicio/imagen
  if (!argv.length) return;
  if (argv.some((w) => w.text === null)) { if (SENSITIVE_VOCAB.test(argv.map((w) => w.approx).join(' '))) out.d('H-13', 'comando dinámico dentro de docker con vocabulario sensible'); return; }
  const line = argv.map((w) => w.raw).join(' ');
  await nested(line, 'bash', ctx, out, 'docker exec/run');
}
