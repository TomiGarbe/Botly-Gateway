---
name: botly-review
description: Checklist y formato de revisión de código de Botly (Core FastAPI + panel React, y Gateway FastAPI + frontend). Usar al revisar un diff o un cambio antes de integrarlo, como code-reviewer o security-engineer, o cuando el CTO revisa el trabajo de un implementer.
---

# Revisión de un cambio en Botly

## Cómo revisar sin gastar de más

1. Partí del **diff y la lista de archivos** que te pasaron. Si no están, pedilos (BLOCKED); no
   reconstruyas el cambio leyendo el repo entero.
2. Leé los hunks cambiados y sólo el contexto que necesitás para entenderlos (la función, el modelo,
   el test). No abras archivos enteros "por las dudas".
3. Una sola pasada. Si algo no se puede verificar leyendo, anotalo como sospecha y seguí.
4. Tope orientativo: los 10 hallazgos más importantes. Lo menor, agrupado en una línea.

## Checklist general

- Correctitud y casos borde (nulos, listas vacías, reintentos, mensajes duplicados o fuera de orden,
  zonas horarias del negocio).
- **Aislamiento por negocio**: toda consulta de datos de negocio filtra por el `business_id` del
  usuario autenticado o del canal resuelto; un id que viene del cliente se verifica contra ese negocio.
- Autorización **por recurso**: el usuario puede tocar *ese* bot, contacto, conversación, canal o
  integración; no alcanza con estar logueado.
- Contratos entre Core y Gateway (`CanonicalInboundEvent` / `CanonicalOutboundMessage`, contratos en
  `docs/contracts/` del Gateway): un cambio de un lado sin el otro es un hallazgo.
- Webhooks: autenticados (API key o firma del proveedor), idempotentes y sin confiar en el payload
  para decidir el negocio.
- Toda migración con test, `downgrade()` razonable o explicación, y sin pisar datos existentes. En
  F1 la migración corre en el deploy (`alembic upgrade head`) contra producción.
- Tests del cambio presentes y que fallarían sin el arreglo.
- Sin secretos, tokens ni datos personales (teléfonos, mensajes de contactos) en código, logs o
  fixtures. Sin cambios fuera del alcance.

## Checklist de seguridad (también para security-engineer)

- IA: el contenido de mensajes de contactos y del conocimiento cargado es entrada no confiable; no
  puede cambiar instrucciones del sistema, elegir otro negocio ni habilitar herramientas.
  Herramientas del runtime con efectos (agenda, planillas, CRM) validan negocio y permisos.
- Credenciales de integraciones de terceros: cifradas en reposo, nunca devueltas al panel ni
  logueadas; tokens OAuth con el alcance mínimo.
- Rate limiting en rutas sensibles (`bot/app/core/rate_limit.py`) y que la IP sea la real del cliente
  detrás de Cloudflare (`CF-Connecting-IP`, nunca `X-Forwarded-For` sin validar).
- Validación de entrada con esquemas Pydantic antes de llegar a la base; SQL sólo parametrizado
  (ORM o `text()` con parámetros, nunca f-strings con datos del usuario).
- XSS: nada de `dangerouslySetInnerHTML` ni HTML armado con datos de contactos sin escapar.
- Claves en el front: cualquier clave que no sea pública por diseño en `VITE_*` es bloqueante.
- Comparaciones de tokens y API keys con `hmac.compare_digest`.
- Archivos y medios: tipo y tamaño validados, sin servir archivos de otro negocio, sin rutas
  armadas con datos del usuario.

## Formato de entrega

```
Cambio: <resumen> · Estado propuesto: REVIEW | BLOCKED
Hallazgos: <bloqueante|importante|menor> — <archivo:línea> — <problema> — <escenario> — <sugerencia>
Evidencia: <qué revisaste> → <resultado>
No revisado / sospechas: …
Decisiones del owner: …
```

"Sin hallazgos" no es aprobación: decí qué revisaste y qué no.
