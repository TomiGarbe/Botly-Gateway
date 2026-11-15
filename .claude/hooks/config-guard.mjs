#!/usr/bin/env node
// Hook ConfigChange: impide que la SESIÓN EN CURSO aplique un cambio de settings que apague o
// debilite los controles. Límite documentado: no protege sesiones nuevas (leen los archivos tal
// como estén) y Claude Code no muestra aviso al bloquear (sólo deja una línea en el log de debug).
// Falla cerrado: error interno -> exit 2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'settings.template.json');

function block(msg) {
  process.stderr.write(`CONFIG BLOQUEADA: ${msg}\n`);
  process.exitCode = 2;
}

function hookCommands(cfg, event) {
  const out = [];
  for (const m of cfg?.hooks?.[event] ?? []) for (const h of m.hooks ?? []) out.push([h.command, ...(h.args ?? [])].join(' '));
  return out;
}

export function evaluate(source, filePath, text) {
  if (text === null) return source === 'project_settings' ? 'se eliminó .claude/settings.json' : null;
  let cfg;
  try { cfg = JSON.parse(text); } catch { return 'el archivo de settings no es JSON válido'; }
  if (cfg.disableAllHooks === true) return 'disableAllHooks: true apagaría los hooks';
  if (cfg.permissions?.defaultMode === 'bypassPermissions') return 'defaultMode bypassPermissions';
  if (cfg.permissions?.disableBypassPermissionsMode && cfg.permissions.disableBypassPermissionsMode !== 'disable') return 'disableBypassPermissionsMode distinto de "disable"';
  if (source !== 'project_settings') return null;
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  for (const kind of ['deny', 'ask']) {
    const have = new Set(cfg.permissions?.[kind] ?? []);
    const missing = (tpl.permissions?.[kind] ?? []).filter((r) => !have.has(r));
    if (missing.length) return `faltan reglas ${kind} obligatorias (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''})`;
  }
  // Allowlist OWNER: en la sesión en curso, settings.json no puede permitir más que la plantilla.
  // Ampliarla exige editar la plantilla (ruta protegida, confirmación + autorización del owner).
  const tplAllow = new Set(tpl.permissions?.allow ?? []);
  const extra = (cfg.permissions?.allow ?? []).filter((r) => !tplAllow.has(r));
  if (extra.length) return `reglas allow fuera de la plantilla (${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ', ...' : ''})`;
  if ((cfg.permissions?.defaultMode ?? null) !== (tpl.permissions?.defaultMode ?? null)) return `defaultMode distinto de la plantilla (${cfg.permissions?.defaultMode ?? 'sin definir'})`;
  if (cfg.permissions?.disableBypassPermissionsMode !== 'disable') return 'falta disableBypassPermissionsMode: "disable"';
  if (tpl.permissions?.disableAutoMode === 'disable' && cfg.permissions?.disableAutoMode !== 'disable' && cfg.disableAutoMode !== 'disable') return 'falta disableAutoMode: "disable"';
  if (cfg.disableAllHooks !== false) return 'falta disableAllHooks: false';
  for (const ev of ['PreToolUse', 'ConfigChange']) {
    const want = hookCommands(tpl, ev);
    const have = new Set(hookCommands(cfg, ev));
    if (want.some((w) => !have.has(w))) return `falta el hook ${ev} obligatorio`;
  }
  return null;
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const source = input.source;
  if (!['user_settings', 'project_settings', 'local_settings'].includes(source)) return;
  const fp = input.file_path;
  let text = null;
  if (fp) { try { text = fs.readFileSync(fp, 'utf8'); } catch { text = null; } }
  else if (source === 'project_settings') text = null;
  const why = evaluate(source, fp, text);
  if (why) block(`${source}: ${why}. El cambio no se aplica a esta sesión; si el owner lo autorizó, se aplica al reiniciar la sesión.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => block(`error interno (${String(e && e.message || e).slice(0, 200)})`));
}
