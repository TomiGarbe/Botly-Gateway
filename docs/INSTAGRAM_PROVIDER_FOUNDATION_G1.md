# Botly Gateway — Instagram Provider Foundation (G1)

## Estado

G1 entrega una **foundation** de arquitectura. Instagram no está habilitado,
implementado de punta a punta ni listo para producción. No incorpora Business
Login, OAuth, callback, webhook público de Instagram, envío público, ni media
de producción.

## Provider y channel type

`channel_type` identifica el canal funcional; `provider` identifica el
transporte que lo opera. Son dimensiones independientes:

| channel_type | provider | adapter |
| --- | --- | --- |
| `whatsapp` | `evolution` | transporte WhatsApp legado |
| `whatsapp` | `meta` | WhatsApp Cloud existente |
| `instagram` | `meta` | `MetaInstagramProvider` (G1 foundation) |

`ProviderRegistry` registra la tupla exacta `(provider_id, channel_type)`.
No existe fallback de `meta` a WhatsApp ni de `evolution` a Instagram. Para
agregar una combinación se registra explícitamente su adapter en
`app/providers/defaults.py` y se agregan sus tests.

Instagram usa el runtime `meta`; ya no declara una identidad de Evolution.
Los flujos existentes de WhatsApp continúan en Evolution donde ya lo hacían.

## Identidades

`ProviderAccountReference(provider_id, channel_type, provider_account_id)`
representa la cuenta externa de la empresa en el provider. Para Instagram,
`provider_account_id` es el ID opaco de la cuenta profesional, por ejemplo
`"178400012345678"`.

El external ID del destinatario/remitente es otra identidad: representa al
usuario de Instagram que participa en el mensaje. No es un `provider_account_id`.
Ambos se conservan como strings opacos: nunca se normalizan como teléfono, no
se convierten a número y no se generan JIDs o `remoteJid`.

## Credenciales

La persistencia WhatsApp `official` no fue modificada ni migrada. Se añadió un
bucket aditivo `providerAccounts` con `ProviderCredentialRecord`, compuesto por
provider, channel type, provider account ID, referencia de token, token cifrado,
hash, scopes, expiración y metadata. Es la ruta de almacenamiento para G2; no
ejecuta OAuth ni refresh.

Se conserva el cifrado Fernet actual y su fallback compatible a
`GATEWAY_API_KEY`. Producción debe configurar
`OFFICIAL_CREDENTIALS_ENCRYPTION_KEY` dedicado antes de persistir tokens de
larga duración.

## Capabilities y estados

Las capabilities del adapter expresan estado, no promesas de disponibilidad:

- `foundation`: existe contrato o parser aislado, sin flujo público.
- `implemented`: flujo completo operable (ninguna capability de Instagram G1).
- `enabled`: producto permitido por settings (false en G1).
- `ready`: listo para producción (false en G1).

El catálogo de producto conserva Instagram como `implemented=false` y
`enabled=false`; `FEATURE_INSTAGRAM=true` no puede volverlo operativo. El
catálogo de dominio solamente publica `supports_text` para Instagram, no
declara webhook, OAuth, media, reacciones ni templates como soporte actual.

## Normalización

`MetaInstagramProvider` valida y analiza payloads específicos de Meta
Instagram hacia eventos normalizados del provider. Esta salida sigue siendo
interna al Gateway y **no** es el contrato canónico final de Botly Core. El
adapter almacena `providerAccountId`, `sender` y `recipient` separados; G1 no
instala router ni dispatcher productivo para `object=instagram`.

## Responsabilidades

Gateway posee transporte, parsing específico del provider, resolución de
channel/account y almacenamiento de credenciales cifradas. Botly Core posee
Business, Contact, Conversation, Message, Bot, AI y Agent. G1 no agrega lógica
de ese dominio al Gateway.

## Próximas fases

- G2: Instagram Business Login y ciclo de token.
- G3: webhook de Instagram, binding account → channel/connection y dispatcher.
- G4: evento canónico acordado con Core.
- G5: outbound por recipient external ID.
- G6: media por Graph API.

Hasta B3 no se reemplaza el contrato legado `{instance_name, number, text}`:
esa compatibilidad WhatsApp se mantiene y no sirve para Instagram.
