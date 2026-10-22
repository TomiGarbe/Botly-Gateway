# WhatsApp groups: canonical-v2 / P0

Status: implemented and tested with synthetic fixtures and HTTP mocks. **No live
Evolution/WhatsApp group compatibility has been certified. Do not deploy this
Gateway change independently of Core P0.** Baseline inspected: `0581c4b`; checkout
matched the reported diagnosis. Core is unchanged by this PR.

## Exact shared contract

JSON Schemas (Draft 2020-12, generated from strict Pydantic DTOs, nested
`additionalProperties: false`):

- `inbound.schema.json`: Gateway → Core. Header `X-Botly-Contract-Version: canonical-v2`.
- `outbound.schema.json`: Core → `POST /v2/outbound/messages`, same version header.
- `accepted.schema.json`: outbound HTTP 202 acknowledgment (provider acceptance,
  not proof of delivery/read). Same response shape as canonical-v1.
- `binding.schema.json`, `policy.schema.json`, `replay.schema.json`: service controls.
- `fixtures/provider-*.json` and paired `fixtures/inbound-*.json`: synthetic
  provider input and exact Core input for two authors, own message, unknown author.
- `fixtures/outbound-group-text.json`, `fixtures/accepted-group-text.json`:
  Core output and Gateway acknowledgment. `policy-disabled.json`: safe initial policy.

Regenerate schemas with `PYTHONPATH=gateway python scripts/export_canonical_v2_schemas.py`.
Tests verify schema/model parity and exact fixture projection. Both endpoints
must implement these schemas; never append v2 fields to strict canonical-v1.

An inbound event identifies `chat.type` (`direct` or `group`) and opaque
`chat.externalId` separately from `author.externalId` and `author.displayName`.
P0 emits v2 for **groups only**; individual WhatsApp and Instagram retain their
current ingress paths/contracts. There is no fabricated group contact. The
provider account routing ref is the registered Evolution instance name;
`connectionRef` is Gateway's stable connection ID. Neither is a person's identity.

All fields describing evidence are present. Unknown identity/name/time/fromMe,
mentions or quote are `null`, never a phone derived from a JID/LID. No stanza
means `quoted: null`; quote with missing participant has unknown quoted author.
The current message's `contextInfo.mentionedJid` alone supplies `mentions`; quote
contents are never searched for mentions. An available context with no mentions
produces `[]`; unavailable context produces `null`. `quoted.providerMessageId`
and its author are provider evidence; no `replyToBot` or `invoked` is inferred.
`occurredAt` is Evolution's message timestamp in Unix milliseconds, or `null`;
Gateway arrival time is not substituted. `botAccount` is supplied by authenticated
Core policy from a verified account identity; when unavailable use null identity
and name. Gateway never derives it from an instance label or guesses JID/LID aliases.

Core must preserve authors and own history, suppress AI for `fromMe: true` (and
handle unknown direction conservatively), resolve identity aliases explicitly,
and invoke only on a real current mention of the bot or a direct quote of its
message. Core may use stored provider-message evidence to resolve an unknown
quoted author; Gateway does not. Finding the word “Botly” has no semantic effect.
Business authorization, AI policy, summaries and panel behavior belong to Core.
Panel summaries must not use the outbound transport to post to WhatsApp.

## Authentication, authorization and rollout

No new environment variables. Existing controls are used as follows:

| Control | Purpose / default |
|---|---|
| `ENABLE_GROUP_MESSAGES` | General transport kill switch, defaults `true`; set `false` to stop all group transport. Insufficient by itself: Core still has to register the account binding |
| binding `groupTransport.contractVersion` | Must be exactly `canonical-v2`; absent means disabled |
| binding `groupTransport.enabled` | Explicit compatibility enable, defaults `false` |
| binding `groupTransport.authorizedGroups` | Complete JIDs explicitly authorized by Core; no wildcard |
| binding `groupTransport.evolutionApiProfile` | Explicit `evolution-v2-sendText` profile; others rejected |
| `GATEWAY_CONTROL_PLANE_API_KEY` | Separate server-to-server secret for group controls and existing Core control-plane client |
| `CORE_CONTROL_PLANE_URL` | Core control-plane; must support WhatsApp bindings before activation |
| `CORE_INBOUND_URL` | Core receiver supporting v1 and v2 selected by version header |
| `CORE_CHANNEL_CREDENTIALS_PATH`, `CORE_CHANNEL_CREDENTIALS_ENCRYPTION_KEY` | Existing encrypted per-channel delivery credential storage |
| `CONNECTION_REGISTRY_PATH` | Persistent binding and group authorization |
| `CORE_INBOUND_DELIVERIES_PATH`, `CORE_INBOUND_DELIVERY_*` | Existing durable outbox, retries/backoff/leases |

Service controls require `Authorization: Bearer <GATEWAY_CONTROL_PLANE_API_KEY>`.
Browser sessions, reviewer sessions, instance tokens and Gateway's general API
key cannot grant group authorization (unless an operator misconfigures secrets
to be identical). Never expose the control secret to the panel/browser.

1. Finish Core P0 first: strict v2 DTOs/schema tests, WhatsApp control-plane
   binding support, panel group authorization, author-aware history, bot identity,
   invocation policy, own-message handling and panel-only summaries.
2. Release compatible Core and Gateway together under disabled flags/policies.
   Preserve v1 and the legacy direct-message paths. Do not merge for automatic
   production deployment until the joint release is authorized.
3. Core server calls `POST /v2/group-transport/binding` with
   `{connectionRef, coreChannelId}`. Gateway resolves the connection/client,
   requests a WhatsApp binding from authenticated Core, validates returned channel
   ID/type, and encrypts the dispatch credential. This creates **no group grant**.
   Rebinding drops the previous group policy. Core must return canonical-v2
   compatible bindings only for the completed P0 integration.
4. Core calls `PUT /v2/group-transport/policy` with the exact policy schema and
   returned binding ID. Only Evolution/WhatsApp is accepted. Connection, channel
   and binding must match the stored binding; replacement is atomic. Supply the
   profile, verified bot identity (or nulls) and explicit group list. Start disabled.
5. After controlled verification, set the global capacity flag and enable only
   the selected binding/groups from Core. A flag alone never sends groups through
   legacy webhooks. Removal from `authorizedGroups` or `enabled: false` revokes
   both reception and queued/outbound forwarding. Every retry checks again.
6. Rollback: disable policy or global capacity. Pending v2 events fail safely on
   authorization recheck; no conversion to v1 or fallback to private recipients.
   Leave persistent stores intact. Rebind/regrant explicitly before a later replay.

Provider webhooks still use authenticated `/webhooks/evolution`, resolve the
registered instance, and verify its provider/channel/binding/group policy.
Groups cannot use the optional insecure Evolution webhook bypass. Unregistered
instances or mismatched bindings never gain group access.

Outbound v2 requires a Gateway service API key or the existing authenticated
instance token. Connection, Core channel, provider/channel and binding are checked;
instance tokens cannot target another connection. Group recipients require
`recipient.type: group` plus a complete authorized `@g.us` JID. It reaches
Evolution's `POST /message/sendText/{instance}` body `number` unchanged. No group
is converted to digits or redirected to its author. Legacy/canonical-v1 group
requests are rejected before number conversion. V2 direct destinations currently
accept only explicit ASCII numeric Evolution addresses unchanged; opaque direct
JID/LID destinations are rejected rather than converted. V1 direct behavior stays
compatible. Group media and unsupported providers/profiles are rejected.

## Reliability and replay

Group ingestion branches before legacy anti-echo/flood/dedupe, generic timeline
persistence and webhook fanout. Only the strict canonical projection goes into
the existing Core outbox; credentials and provider raw bodies are excluded.
Provider acknowledgment follows successful durable enqueue; persistence failure
returns an error so Evolution can retry. A duplicate returns the existing event.

Event ID: `wa2_` + SHA-256 of compact JSON
`[connectionId,bindingId,groupJid,providerMessageId,fromMe,"message"]`.
The durable secondary dedupe scope also includes provider/channel/account,
connection, binding, group, event type, direction and provider message ID.
Retries, lease recovery, provider replay and explicit replay preserve the full
original event, ID, authors, mentions and quote. Missing provider message IDs are
rejected (`group_invalid_event`); no unstable random IDs are invented.

Explicit replay: Core server calls
`POST /v2/group-transport/deliveries/{deliveryId}/replay` with
`{connectionRef,coreChannelId,bindingId}`. Obtain the delivery ID from the safe
`group_transport_event_persisted` operational log or the private outbox. Current grant and stored event scope
must match. Failed/dead-letter/retry deliveries are requeued with the original
event; delivered, pending and in-flight deliveries are left unchanged. Authorization
is checked again at actual HTTP delivery. Existing outbox operational metadata
and dispatcher logs contain delivery/event IDs, not message text.

Outbound reuses the existing persistent attempt store. V2 idempotency keys are
internally scoped by connection, binding, recipient type and original key,
plus the existing Core-channel/exact-recipient scope. The client acknowledgment
retains its original key. Accepted attempts are reused; in-flight/uncertain
outcomes return 409 and are not resent automatically. The adapter performs zero
HTTP retries for sendText. Core must reconcile an uncertain send rather than
create another idempotency key blindly.

Core acknowledges successful intake with 2xx; this boundary also follows the
existing dispatcher rule that 409 means an already-processed duplicate, **not**
a generic business rejection. Core must not use 409 for other failures here.
Transient failures retry with existing backoff; permanent validation/auth failures
are retained as failed deliveries. Authorization is checked again before replay.

## Capability evidence and limitations

| Capability | Evidence in this PR | Live verification |
|---|---|---|
| Evolution group text ingress, authors, opaque LID/JID | Synthetic provider fixtures and exact projection tests | Pending |
| Current mentions vs quoted mentions; direct quote | Synthetic contextInfo fixtures and tests | Pending |
| Own messages retained as own, duplicate/retry/restart/replay | Durable store + Core HTTP mocks | Pending |
| Group text egress, complete destination | Real Evolution adapter with mocked HTTP request body | Pending; profile/version must be recorded |
| Per-binding grants, connection/group isolation, revocation | Negative tests and authenticated controls | Pending end-to-end Core panel |
| Direct WhatsApp, Instagram, canonical-v1 | Gateway regression suite | No new live claim |
| Group media, reactions, polls, mentions on outbound | No v2 implementation; text only | Unsupported for P0 |
| Group receipts and membership updates | Distinct `group_receipt_unsupported` / `group_membership_unsupported` responses, never customer messages | Payload semantics unverified; not forwarded |
| Bot JID/LID aliases and quoted-author enrichment | Unknowns preserved, identity supplied by Core | Must be verified with actual account |

P0 v2 carries text/message kind and reference context; it does not claim full
attachment/media transfer or membership history. Group events bypass the generic
Gateway browser message timeline; Core's author-aware panel is the product history.
JSON stores use atomic replacement and process locks, following existing Gateway
architecture: operate with one writer process and durable volumes. This PR does
not introduce distributed locking or unbounded-retention cleanup. Do not run
multiple independent workers against the same JSON stores. Outbox read failures
raise instead of silently replacing persisted events.

No production conversations, credentials or provider payload captures belong in
fixtures or logs. New fixtures are synthetic; Evolution auth logging no longer
prints credential prefixes or quoted message previews. Runtime outbox content is
private operational state (0600), not an exported fixture or public log.

## Controlled real test (joint release only)

1. Use a dedicated test account and consenting test users, two disposable groups,
   two authors, and a second connection. Record Evolution image/API version and
   Baileys integration. Verify complete group destination format for that build.
2. Register the test connection, create its Core binding and disabled policy.
   Confirm messages to either group reach neither Core nor legacy webhook targets.
   Enable capacity alone and repeat: still blocked. Grant group A only via Core.
3. Send synthetic marked messages from both authors in A and in ungranted B.
   Verify A history shares a chat but preserves separate author IDs/names; B and
   the second connection stay isolated. Repeat after granting/revoking B separately.
4. Test plain text containing “Botly” (history only), current mention of the bot
   (Core may answer), mention solely inside quoted text (no invocation), direct
   reply to a bot message (Core may answer), reply to another author (no invocation),
   and quote with missing author evidence (unknown until Core resolves it).
5. Send from the bot/test account. Verify `fromMe`, bot-account identity and actual
   provider JID/LID aliases; no own message causes a new AI customer response.
   Confirm receipt/membership events do not become customer messages.
6. Pause Core, send marked synthetic messages, restart Gateway on the same volume,
   resume Core, and verify retry delivery has identical event/provider IDs and
   context. Redeliver a provider webhook and exercise authenticated replay; one
   logical Core history entry results. Revoke a group while queued: no HTTP delivery.
7. Request a synthetic text reply from Core using the fixture's v2 shape. Inspect
   only safe metadata and the test destination: it must reach group A, never an
   author's private chat. Repeat the same idempotency key: one provider send.
   Try wrong channel/connection/binding, ungranted group, media and unsupported
   provider: all rejected before provider HTTP. Test provider timeout reconciliation.
8. Ask for a summary in Botly's panel: verify it stays in the panel and produces
   no outbound WhatsApp send. Verify existing direct WhatsApp and Instagram flows.
9. Disable grants and capacity, remove test data under the agreed retention rules,
   and record sanitized results and actual verified capabilities. Do not commit
   credentials or real conversations. Production rollout waits for all P0 checks.
