// Datos propios de este repositorio (Botly Gateway). Es el único archivo del hook que cambia entre
// los repos que comparten el sistema de agentes (Botly Core, Botly Gateway, Rivo): el resto de
// lib/ es idéntico. Ver docs/agents/decisions.md (BA-01).

export const PROJECT = 'Botly Gateway';

// D-7: alcance de escritura de cada subagente dentro de su worktree (rutas relativas a la raíz).
export const SCOPES = {
  'backend-implementer': ['gateway/app', 'gateway/tests'],
  'frontend-implementer': ['frontend/src'],
};

// H-05: scripts de deploy a F1 que nunca se ejecutan a mano (prefijo del nombre del programa).
export const DEPLOY_SCRIPTS = ['botly-deploy-backend', 'botly-deploy-gateway'];

// H-06: scripts de datos que escriben en una base (además de cualquier `seed_*`).
export const DATA_SCRIPTS = [
  'seed_jd_media_local_fixture', 'restore_jd_media_v2_fixture', 'reconcile_jd_media_f1',
  'transfer_neon_to_local_target', 'provision_gateway_tenant', 'sync_evolution_channel',
];

// H-10: documentos con skip-worktree que no se tocan. El Gateway no tiene ninguno; los tests agregan los
// suyos por CLAUDE_GUARD_EXTRA_PROTECTED_DOCS (sólo suma rutas: nunca afloja el control).
const EXTRA_DOCS = (process.env.CLAUDE_GUARD_EXTRA_PROTECTED_DOCS || '').split(';').filter(Boolean);
export const PROTECTED_DOCS = [...EXTRA_DOCS];
