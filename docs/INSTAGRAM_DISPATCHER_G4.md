# Instagram Dispatcher / Core Delivery (G4)

## Architecture

```text
Meta Instagram
      ->
G3 Webhook
      ->
CanonicalInboundEvent
      ->
Persistent Delivery
      ->
G4 Dispatcher
      ->
Bearer Channel API Key
      ->
POST /api/v1/webhook/inbound
      ->
Botly Core B4
      ->
InboundPipelineService
```

G4 is transport only. It does not resolve Contacts, Conversations, Messages, AI, bot behavior, Instagram outbound, or media downloads.

## G3 to G4 flow

For `object=instagram`, G3 verifies the raw Meta signature, resolves `entry.id` through the persisted Meta Instagram Connection, and normalizes each supported inbound event. Before the webhook acknowledges Meta, G4 persists that canonical event in `CORE_INBOUND_DELIVERIES_PATH`. The HTTP response does not expose event content.

The startup worker claims `pending` or due `retry` records, including expired leases left by a stopped process, and delivers them independently. Therefore delivery is not dependent on `asyncio.create_task` created by the webhook request.

## Connection to Core Channel binding

One Instagram Connection has one explicit persisted `core_channel` reference:

```text
Instagram provider account -> Gateway Connection -> Core channel ID -> encrypted Channel API key
```

An authorized reviewer configures it with `PUT /connections/{connection_id}/instagram/core-channel`. The request accepts `core_channel_id` and `channel_api_key`; the API key is encrypted in `CORE_CHANNEL_CREDENTIALS_PATH` and never returned by Connection APIs. The Connection record retains only the Core channel ID and an opaque credential reference.

The binding is neither inferred from `sender.id`, `recipient.id`, Meta `business_id`, phone values, nor a global provider-account lookup. Disconnecting or deleting an Instagram Connection removes this Core credential and binding.

## Core authentication and contract

The dispatcher posts only the G3 canonical event to `CORE_INBOUND_URL` with:

```text
Authorization: Bearer <the bound Channel API key>
X-Botly-Contract-Version: canonical-v1
Content-Type: application/json
```

It never sends Meta access tokens, OAuth tokens, the Meta app secret, or provider credential records. G3 keeps external IDs opaque and adds `requestId` and `correlationId` to `trace`.

## Persistent delivery and deduplication

Each record stores a private canonical event plus `eventId`, provider/channel/account/connection/Core-channel references, state, attempts, retry timestamps, lease, delivery time, and safe error code. It is written atomically with the existing Gateway JSON-store pattern and restrictive filesystem permissions.

`eventId` identifies one logical Gateway handoff. Provider-message dedupe is namespaced by:

```text
provider + channelType + providerAccountId + providerMessageId
```

Thus a matching Meta message ID on two different Instagram professional accounts remains two separate deliveries. A duplicate persistence request returns the original logical delivery.

## Retry, recovery, and errors

- `2xx`: `delivered`.
- `409`: logical `delivered` with `duplicateAcknowledged=true`, consistent with B4's idempotent inbound conflict behavior.
- `400`, `401`, `403`, `404`, `405`, `410`, `422`: permanent `failed`.
- timeout, transport errors, `429`, and server errors: `retry` with bounded exponential backoff; after `CORE_INBOUND_DELIVERY_MAX_ATTEMPTS`, `dead_letter`.
- Missing Core URL/binding/Channel key: persisted permanent `failed`, so the event is retained for diagnosis rather than silently discarded.

The worker reclaims expired `delivering` leases after restart. JSON storage follows the repository's existing in-process lock and atomic-replace convention; multi-process deployments should retain a single Gateway dispatcher writer until the persistence layer is upgraded to a shared transactional store.

## Tenant isolation, observability, and compatibility

Safe structured logs cover persistence, attempt, success, retry, permanent failure, and dead-letter with event, provider-account, connection, Core-channel, attempt, status, and latency identifiers. They do not log API keys or canonical message bodies.

This is additive. Meta WhatsApp and Evolution paths retain their existing forwarding implementation. The Instagram provider capability now reaches durable Core delivery without bringing provider-specific IDs into the canonical contract.

## Tests

`gateway/tests/test_instagram_dispatcher.py` covers G3 canonical event persistence, authenticated Core delivery, contract header/body, no Meta-token leakage, event and scoped-provider-message dedupe, permanent failures, retryable server/timeout failures, idempotent conflicts, and restart recovery. Existing G3, Connection/OAuth, registry, Meta WhatsApp, and Evolution suites remain regression coverage.
