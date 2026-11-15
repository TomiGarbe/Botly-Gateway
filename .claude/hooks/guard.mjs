#!/usr/bin/env node
// Hook PreToolUse del CTO (sistema de agentes compartido con Rivo; datos del repo en lib/project.mjs). Lee el JSON de Claude Code por stdin y decide:
//   bloquear -> mensaje en stderr + exit 2 (bloquea antes que las reglas; un allow no lo anula)
//   confirmar -> JSON permissionDecision "ask" por stdout + exit 0
//   permitir -> exit 0 sin salida
// Falla cerrado: cualquier error interno sale con exit 2. Además settings.json declara
// onFailure: "block" para timeouts o crashes. No existe variable ni marca que lo desactive.
import { decide } from './lib/decide.mjs';

const MAX_INPUT = 4 * 1024 * 1024;

function block(rule, msg) {
  process.stderr.write(`BLOQUEADO [${rule}]: ${msg}. Si la operación es necesaria, pedile al owner que la ejecute o la autorice explícitamente en el chat.\n`);
  process.exitCode = 2;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    if (size > MAX_INPUT) throw new Error('entrada demasiado grande');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { input = null; }
  if (!input || typeof input !== 'object') {
    block('GUARD', 'entrada del hook ilegible');
  } else {
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd;
    const r = await decide(input, { root });
    if (r.decision === 'deny') block(r.rule, r.msg);
    else if (r.decision === 'ask') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[${r.rule}] ${r.msg}` },
      }));
      process.exitCode = 0;
    } else process.exitCode = 0;
  }
} catch (e) {
  block('GUARD-ERROR', `el hook no pudo analizar la operación (${String(e && e.message || e).slice(0, 200)})`);
}
