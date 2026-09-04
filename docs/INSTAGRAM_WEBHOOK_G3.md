# Instagram Webhook Foundation (G3)

## Scope

G3 adds the Meta Instagram webhook reception boundary in Botly Gateway. It validates Meta's request, resolves the persisted Gateway binding, and produces canonical inbound-event dictionaries for G4. It does not dispatch to Botly Core, create contacts/conversations/messages, send outbound messages, refresh tokens, or download media.

## Endpoint and verification

Meta uses the shared endpoint `GET|POST /webhooks/meta`.

- `GET` validates `hub.mode=subscribe`, the configured `hub.verify_token`, and a non-empty `hub.challenge`. It responds with exactly the challenge. The configured token is compared in constant time and is never logged.
- `POST` reads the raw request bytes first and validates `X-Hub-Signature-256` as `sha256=<HMAC-SHA256(raw-body, META_APP_SECRET)>` with `hmac.compare_digest`.
- `META_APP_SECRET` is the sole key for this signature; gateway API keys, provider credentials, access tokens, and request JSON are never used as a substitute. Invalid, missing, malformed, modified-body, or wrong-secret signatures are rejected before parsing JSON.

The existing `object=whatsapp_business_account` branch remains separate and unchanged. `object=instagram` never reaches the WhatsApp parser.

## Payload, account, and connection resolution

The receiver accepts Meta extensions but requires `object="instagram"` and an `entry` list. For messaging subscriptions, `entry.id` is treated as the subscribed Instagram professional account, i.e. the `providerAccountId`. It is preserved as an opaque string.

`sender.id` is always the customer's external identity; `recipient.id` is copied to the canonical recipient (falling back to `entry.id`). Neither is used to select a tenant or connection. No `business_id` supplied by a webhook is trusted.

The account is resolved exclusively through the persisted `Connection.provider_account` binding. A matching record must have `provider=meta`, `channel=instagram`, exactly one binding, and `status=connected`. Unknown accounts return 404; inactive, malformed, or ambiguous bindings return 409. The global unique binding check prevents the same professional account from being connected by another tenant.

## Canonical G4 handoff

`app.services.instagram_webhook.process_instagram_webhook` returns one dictionary per supported provider event. This is the explicit G3/G4 handoff boundary; the HTTP response only reports counts and never includes canonical content.

```json
{
  "eventId": "Gateway-generated UUID",
  "eventType": "message.created",
  "occurredAt": "2024-03-09T16:00:00Z",
  "transport": {
    "provider": "meta",
    "channelType": "instagram",
    "connectionRef": "persisted Gateway connection ID",
    "providerAccountRef": "Instagram professional account ID"
  },
  "message": {
    "providerMessageId": "Meta mid when supplied",
    "direction": "inbound",
    "kind": "text",
    "content": "unaltered text",
    "sender": {"externalId": "Instagram user ID"},
    "recipient": {"externalId": "Instagram account ID"},
    "attachments": []
  },
  "metadata": {"sourceTimestamp": "..."},
  "trace": {"requestId": "Gateway request ID"}
}
```

`eventId` is a new Gateway UUID for each delivery and is intentionally distinct from Meta's `providerMessageId`. If Meta supplies no message ID, `providerMessageId` is `null`; Gateway never invents one. A valid Meta timestamp is normalized to timezone-aware UTC and retained in `metadata.sourceTimestamp`; only an absent/invalid provider timestamp falls back to receipt time. This preserves the fields G4 needs for deduplication: event ID, provider message ID, provider account ID, and connection ID.

Text is not trimmed or semantically normalized. Attachments preserve available `kind`, `providerMediaId`, URL, MIME type, filename, size, and metadata; media is not downloaded. A reaction produces `message.reaction`, and a postback produces `message.postback`. Echo/self messages (`message.is_echo`) and unsupported events are acknowledged but intentionally emit no inbound canonical event. Invalid structural payloads are rejected safely.

## ACK, security, and observability

The endpoint returns promptly after validation, binding resolution, and canonical normalization. G3 intentionally has no background task, durable queue, or Core dispatcher: canonical events are only the documented handoff boundary until G4 supplies delivery and durability semantics.

Structured logs contain only request ID, event ID, provider account ID, connection ID, provider, channel type, and event type. They never contain app secrets, access tokens, authorization codes, or raw Instagram payloads. The endpoint does not execute AI, resolve Core entities, or issue outbound Graph calls.

## Tests and next phases

`gateway/tests/test_instagram_webhook.py` covers challenge validation; valid, invalid, missing, malformed, modified-body, and wrong-secret signature paths; text/non-numeric IDs; attachment, reaction, echo, unsupported, malformed payload, account/connection rejection, ambiguity, and tenant binding. Existing Meta WhatsApp and Evolution tests remain regression coverage.

G4 must implement durable/async delivery of the canonical event to Botly Core, idempotency/deduplication ownership, and Core entity processing. G5 can add production delivery observability/retries and broader provider event coverage; neither phase changes the account-resolution rule established here.
