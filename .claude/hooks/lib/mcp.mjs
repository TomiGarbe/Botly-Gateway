// Controles de herramientas MCP (D-2). Los identificadores de servidor son los verificados en el
// inventario de la sesión del 2026-11-03; un servidor desconocido se clasifica por el verbo.
// Decisiones: allow (lectura), ask (escritura o lectura de datos personales), deny (deploy,
// rollback, variables de entorno, secretos, borrado, cambios de modo/permiso, limpieza de worktrees).

export const SERVERS = {
  VERCEL: '72d3659d-903c-4430-8524-74c65b254d66',
  DRIVE: '79639984-0ab5-4c09-9070-1b8db3cc69a1',
  DOCS: '1a59c906-04da-521d-bda7-7f71b9f9e01c',
};

const VERCEL_DENY = new RegExp('^(' + [
  'create_deployment', 'cancel_deployment', 'request_promote', 'request_rollback',
  '(approve|complete|start)_rolling_release(_stage)?', 'update_rolling_release_config', 'assign_alias',
  '(create|edit|filter|get)_project_env', 'get_shared_env_var', 'buy_domain', 'create_or_transfer_domain',
  'accept_project_transfer_request', 'replace_domain_dns_records', 'create_record', 'update_record',
  'put_firewall_config', 'update_firewall_config', 'update_attack_challenge_mode', 'patch_url_protection_bypass',
  'update_project_protection_bypass', 'get_bypass_ip', 'delete_.*', 'pause_project', 'unpause_project',
  'get_project_deletion_link', '(revoke|activate|create)_kms_signing_key', 'create_sdk_key',
  'create_edge_config_token', 'get_edge_config_tokens?', 'update_project', 'restore_.*', 'authorize_team_.*',
  'create_project', 'create_git_project', 'add_project_domain', 'verify_project_domain', 'issue_cert',
  'update_connector', 'upsert_connector_project_connection', 'run_session_command', 'write_session_files',
  '(create|update)_kms_issuer(_policy)?', 'get_access_to_vercel_url', 'update_project_protection_bypass',
].join('|') + ')$');
const VERCEL_ASK_READ = /^(get_runtime_logs|get_runtime_errors|get_session_command_logs|get_vercel_ci_.*logs|get_deployment_file_contents|read_session_file|web_fetch_vercel_url)$/;
const READ_VERB = /^(get|list|search|count|aggregate|read|describe|find|fetch|resolve|view|show|lookup|whoami|status|guide|query-docs|resolve-library-id|tabs_context|tabs_context_mcp)(_|-|$)/;
const DESTRUCTIVE_VERB = /(^|_)(delete|drop|destroy|purge|wipe|trash|revoke|rollback|deploy|promote|truncate|transfer|buy|pay|charge|reset)(_|$)/;

// Servidores verificados con política explícita por herramienta.
// AG-16 (2026-11-14): lectura siempre permitida y herramientas locales/de la app sin confirmación; se
// confirma sólo lo que toca producción (Vercel), publica a GitHub (merge/push) o comparte/borra archivos.
const TABLE = {
  postgres: { query: 'sql' },
  terminal: { run_in_terminal: 'shell', '*': 'allow' },
  ccd_session_mgmt: { set_session_permission_mode: 'deny', delete_session: 'deny', clear_session: 'deny', '*': 'allow' },
  ccd_session: { '*': 'allow' },
  ccd_host: { clean_up_worktrees: 'deny', discard_kept_worktree: 'deny', '*': 'allow' },
  ccd_pr: { set_auto_merge: 'deny', '*': 'allow' },
  ccd_settings: { '*': 'allow' }, // la app pide aprobación propia para cada cambio
  ccd_directory: { '*': 'allow' },
  ccd_connectors: { '*': 'allow' },
  ccd_view: { '*': 'allow' }, ccd_window: { '*': 'allow' }, ccd_sidebar: { '*': 'allow' }, ccd_turn: { '*': 'allow' },
  'scheduled-tasks': { '*': 'allow' },
  'claude-artifacts': { '*': 'verb' },
  'claude-in-chrome': { '*': 'allow' },
  Claude_Browser: { '*': 'allow' },
  // AG-20: lectura sin diálogo; toda escritura pide confirmación (run_workflow/rerun disparan el deploy
  // de main, update_pull_request puede cambiar la base a main). CLAUDE.md: PR y merge son del owner.
  github: { '*': 'verb' },
  context7: { '*': 'allow' }, 'mcp-registry': { '*': 'allow' }, 'sequential-thinking': { '*': 'allow' }, visualize: { '*': 'allow' },
};

function splitName(toolName) {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return m ? { server: m[1], tool: m[2] } : null;
}

function byVerb(tool) {
  if (DESTRUCTIVE_VERB.test(tool)) return 'deny';
  if (READ_VERB.test(tool)) return 'allow';
  return 'ask';
}

/** Analiza SQL del servidor postgres: escritura o múltiples sentencias -> deny; lectura -> ask. */
export function classifySql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return { decision: 'deny', rule: 'D-2', msg: 'consulta SQL vacía o no textual' };
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
  if (/;\s*\S/.test(stripped)) return { decision: 'deny', rule: 'D-2', msg: 'SQL con varias sentencias' };
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|reindex|cluster|comment|lock|call|do|execute|prepare|set|reset|begin|commit|rollback|savepoint|refresh|merge|import|listen|notify|security|discard)\b/i.test(stripped)
    || /\b(pg_terminate_backend|pg_cancel_backend|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_write\w*|dblink\w*|set_config|setval|nextval|lo_\w+|pg_reload_conf|pg_rotate_logfile|pg_advisory\w*|pg_sleep\w*|pg_switch_wal|pg_create\w*|pg_drop\w*)\b/i.test(stripped)
    || /\bfor\s+(no\s+key\s+)?(update|share)\b/i.test(stripped)) {
    return { decision: 'deny', rule: 'D-2', msg: 'SQL de escritura/administración bloqueado en postgres MCP' };
  }
  return { decision: 'allow' }; // AG-16: lectura permitida sin confirmación
}

/**
 * Devuelve { decision: 'allow'|'ask'|'deny'|'shell', rule, msg, command? }.
 * 'shell' indica que el llamador debe analizar `command` como PowerShell y luego pedir confirmación.
 */
export function classifyMcp(toolName, input = {}) {
  const n = splitName(toolName);
  if (!n) return { decision: 'ask', rule: 'D-2', msg: `herramienta MCP con nombre no reconocible (${toolName})` };
  const { server, tool } = n;

  if (server === SERVERS.VERCEL) {
    if (VERCEL_DENY.test(tool)) return { decision: 'deny', rule: 'D-2', msg: `Vercel ${tool}: deploy/rollback/variables de entorno/secretos/DNS/borrado bloqueados` };
    if (VERCEL_ASK_READ.test(tool)) return { decision: 'allow' }; // AG-16: lectura de logs permitida
    if (/^(get|list|search|count|aggregate)_/.test(tool) || ['git_namespaces', 'artifact_query', 'search_vercel_documentation'].includes(tool)) return { decision: 'allow' };
    return { decision: 'ask', rule: 'D-2', msg: `Vercel ${tool}: escritura, requiere confirmación` };
  }
  if (server === SERVERS.DRIVE || server === SERVERS.DOCS) {
    const v = byVerb(tool);
    // AG-16: crear y editar documentos está permitido; compartir o borrar pide confirmación.
    if (v === 'deny' || ['share_file', 'delete'].includes(tool)) return { decision: 'ask', rule: 'D-2', msg: `${tool}: comparte o borra documentos, requiere confirmación` };
    return { decision: 'allow' };
  }

  const table = TABLE[server];
  if (table) {
    const pol = table[tool] ?? table['*'] ?? 'verb';
    if (pol === 'sql') return classifySql(input.sql);
    if (pol === 'shell') return { decision: 'shell', rule: 'D-2', msg: 'comando en la terminal del usuario: requiere confirmación', command: input.command };
    const d = pol === 'verb' ? (byVerb(tool) === 'deny' ? 'ask' : byVerb(tool)) : pol;
    if (d === 'allow') return { decision: 'allow' };
    return { decision: d, rule: 'D-2', msg: `${server}/${tool}: ${d === 'deny' ? 'bloqueado' : 'requiere confirmación'}` };
  }

  // Servidor desconocido: conservador por verbo.
  const v = byVerb(tool);
  if (v === 'allow') return { decision: 'allow' };
  return { decision: v, rule: 'D-2', msg: `MCP desconocido ${server}/${tool}: ${v === 'deny' ? 'operación destructiva bloqueada' : 'requiere confirmación'}` };
}
