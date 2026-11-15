// Decisión central del PreToolUse: shell, herramientas de archivo, subagentes y MCP.
import { analyzeShell } from './policy.mjs';
import { classifyMcp } from './mcp.mjs';
import * as P from './paths.mjs';
import { SCOPES } from './project.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function summarize(out) {
  if (out.deny.length) return { decision: 'deny', rule: out.deny[0].rule, msg: out.deny[0].msg, all: out.deny };
  if (out.ask.length) return { decision: 'ask', rule: out.ask[0].rule, msg: out.ask[0].msg, all: out.ask };
  return { decision: 'allow' };
}

// Dentro de un worktree, un subagente nunca escribe en estos segmentos (a cualquier profundidad)
// ni con estos nombres de archivo, y sólo escribe bajo el alcance de su tipo (AG-13, AG-15).
const WORKTREE_DENY_SEGMENTS = new Set(['.git', '.claude']);
const WORKTREE_DENY_NAMES = new Set(['claude.md', 'claude.local.md', '.mcp.json']);
// SCOPES: alcance por tipo de agente, en lib/project.mjs.
const ALL_SCOPES = [...new Set(Object.values(SCOPES).flat())];

/** Alcance de escritura según el tipo de subagente; sin tipo informado, la unión; tipo ajeno, nada. */
function scopeFor(agentType) {
  if (agentType == null || agentType === '') return ALL_SCOPES;
  return SCOPES[agentType] ?? [];
}

/** Motivo para negar la escritura de un subagente, o null si cae dentro de su worktree y alcance. */
function subagentWriteBlock(p, cwd, root, agentType) {
  if (typeof p !== 'string' || !p) return 'escritura sin ruta';
  const scope = scopeFor(agentType);
  if (!scope.length) return `el agente ${agentType} no tiene alcance de escritura`;
  if (/^[\\/]{2}/.test(p)) return 'ruta UNC o de dispositivo';
  if (p.replace(/^[a-zA-Z]:/, '').includes(':')) return 'nombre con ":" (flujo alternativo de NTFS)';
  const base = P.resolveFrom(root, '.claude/worktrees');
  const c = P.resolveFrom(cwd, '.');
  if (!P.isWithin(c, base) || c === base) return 'sólo puede escribir desde un worktree de .claude/worktrees/';
  const wt = `${base}/${c.slice(base.length + 1).split('/')[0]}`;
  const r = P.resolveFrom(c, p);
  if (!P.isWithin(r, wt) || r === wt) return 'la ruta queda fuera de su worktree';
  const segs = r.slice(wt.length + 1).split('/');
  for (const s of segs) {
    if (s.includes(':')) return 'nombre con ":" (flujo alternativo de NTFS)';
    if (/~\d/.test(s)) return 'nombre corto 8.3';
    if (/[. ]$/.test(s)) return 'nombre terminado en punto o espacio';
    if (WORKTREE_DENY_SEGMENTS.has(s)) return `ruta reservada del worktree (${s})`;
  }
  if (WORKTREE_DENY_NAMES.has(segs[segs.length - 1])) return `archivo reservado (${segs[segs.length - 1]})`;
  const rel = segs.join('/');
  if (!scope.some((a) => rel.startsWith(`${a}/`))) return `fuera de su alcance (${scope.join(', ')})`;
  return null;
}

/**
 * input: el JSON de PreToolUse. env: { root }.
 * Devuelve { decision: 'allow'|'ask'|'deny', rule?, msg? }.
 */
export async function decide(input, env = {}) {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  const cwd = input.cwd || env.root || process.cwd();
  const root = env.root || cwd;
  const ctx = { cwd, root, depth: 0, canonical: true };

  if (typeof tool !== 'string' || !tool) return { decision: 'deny', rule: 'GUARD', msg: 'entrada sin tool_name' };

  // D-7: un subagente sólo escribe por herramientas de archivo dentro de su propio worktree
  // (`<raíz>/.claude/worktrees/<nombre>/`), nunca en sus controles ni en el checkout principal.
  // Si pasa, siguen aplicando abajo SEC, H-11 y H-10 como para cualquier escritura.
  if (input.agent_id && WRITE_TOOLS.has(tool)) {
    const why = subagentWriteBlock(ti.file_path ?? ti.notebook_path, cwd, root, input.agent_type);
    if (why) return { decision: 'deny', rule: 'D-7', msg: `subagente: ${why}` };
  }

  if (tool === 'Bash' || tool === 'Monitor' || tool === 'PowerShell') {
    const cmd = ti.command;
    if (typeof cmd !== 'string') return { decision: 'deny', rule: 'GUARD', msg: `${tool} sin comando de texto` };
    if (!cmd.trim()) return { decision: 'allow' };
    const shell = tool === 'PowerShell' ? 'ps' : 'bash';
    // Las reglas ask de settings.json (Bash(...)/PowerShell(...)) no cubren Monitor: lo que dependía
    // de ellas (push, ssh, alembic, vercel, gh pr merge...) se trata como no canónico (H-07).
    return summarize(await analyzeShell(cmd, shell, tool === 'Monitor' ? { ...ctx, canonical: false } : ctx));
  }

  if (FILE_TOOLS.has(tool)) {
    const p = ti.file_path ?? ti.notebook_path;
    if (typeof p !== 'string') return { decision: 'deny', rule: 'GUARD', msg: `${tool} sin ruta` };
    const r = P.resolveFrom(cwd, p);
    const why = P.sensitiveReason(p, r);
    if (why) return { decision: 'deny', rule: 'SEC', msg: `archivo sensible (${why})` };
    if (WRITE_TOOLS.has(tool)) {
      if (P.isWithin(r, P.resolveFrom(root, '.git/config'))) return { decision: 'deny', rule: 'H-11', msg: '.git/config puede definir alias ocultos' };
      const doc = P.protectedDocHit(root, r);
      if (doc) return { decision: 'deny', rule: 'H-10', msg: `archivo protegido por skip-worktree (${doc})` };
    }
    return { decision: 'allow' };
  }

  if (tool === 'Grep') {
    for (const v of [ti.path, ti.glob]) {
      if (typeof v !== 'string') continue;
      if (P.sensitiveReason(v, P.resolveFrom(cwd, v))) return { decision: 'deny', rule: 'SEC', msg: 'Grep dirigido a archivos sensibles' };
      if (P.hasGlob(v)) {
        const last = v.replace(/\\/g, '/').split('/').pop().replace(/^\{|\}$/g, '');
        for (const part of last.split(',')) {
          if (['.env', '.env.local', 'x.pem', 'x.key'].some((s) => P.fnmatch(part, s))) return { decision: 'deny', rule: 'SEC', msg: 'Grep con glob que incluye archivos sensibles' };
        }
      }
    }
    return { decision: 'allow' };
  }

  if (tool === 'Glob') return { decision: 'allow' }; // sólo lista nombres; el contenido lo protegen Read/Grep

  if (tool.startsWith('mcp__')) {
    const c = classifyMcp(tool, ti);
    if (c.decision === 'shell') {
      if (typeof c.command !== 'string') return { decision: 'deny', rule: 'D-2', msg: 'run_in_terminal sin comando' };
      // AG-16: el comando de la terminal se analiza como PowerShell. AG-20: las reglas ask de
      // settings.json no aplican a esta herramienta, así que lo que dependía de ellas (push, ssh,
      // alembic, vercel, gh pr merge, docker -H) se bloquea como no canónico (H-07).
      return summarize(await analyzeShell(c.command, 'ps', { ...ctx, canonical: false }));
    }
    return c;
  }

  return { decision: 'allow' };
}
