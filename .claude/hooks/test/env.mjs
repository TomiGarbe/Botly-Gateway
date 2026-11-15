// Se importa primero en cada test: los casos de H-10 usan documentos con skip-worktree de prueba
// (heredados de Rivo). La variable sólo AGREGA rutas protegidas (más bloqueos), nunca quita.
process.env.CLAUDE_GUARD_EXTRA_PROTECTED_DOCS = [
  'docs/MODULO_02_HANDOFF.md',
  'docs/MODULO_01_07_VERIFICACION_IDENTIDAD.md',
  'docs/MODULO_01_HANDOFF_FASE_C.md',
  'docs/FRONTEND_PANTALLAS_PLAN.md',
].join(';');
