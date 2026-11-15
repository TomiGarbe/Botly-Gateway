# Sistema de agentes de Botly

Las reglas de trabajo viven en un solo lugar: [`CLAUDE.md`](../../CLAUDE.md). El sistema es el de
Rivo, portado tal cual (BA-01); esta carpeta sólo guarda material de consulta:

| Archivo | Contenido |
|---|---|
| [decisions.md](decisions.md) | Registro de decisiones del owner sobre el sistema de agentes de Botly (BA-NN) |
| [hook-reference.md](hook-reference.md) | Qué bloquea o confirma cada control técnico (códigos H-NN, SEC, D-N) y cómo actuar cuando uno se activa |

El mismo sistema está en Botly (Core); ambos repos comparten el hook salvo
`.claude/hooks/lib/project.mjs` (alcances de los implementers, scripts de deploy y de datos).
El intento anterior basado en Codex (`AI_TEAM_BOOTSTRAP.md`, nunca versionado) se descartó (BA-01).
