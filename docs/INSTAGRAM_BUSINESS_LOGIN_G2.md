# Botly Gateway — Instagram Business Login (G2)

## Scope

G2 implements the **connection foundation** for Meta Instagram Business Login:
server-side OAuth, a discovered provider account, encrypted credentials and a
deterministic binding to one Gateway Connection. It does not implement inbound
webhooks, Core delivery, messaging, outbound delivery or media.

```
User
  | -> Gateway authorize -> Meta Instagram Login
  |                            |
  +------- Gateway callback <--+
              | validate state
              | exchange code
              | discover account
              | encrypt credential
              + bind Provider Account -> Connection
```

## Start and callback

`GET /connections/meta/instagram/authorize?connection_id=...` requires an
authenticated Gateway user and applies the existing reviewer/client ownership
policy. The target Connection must already be `provider=meta` and
`channel=instagram`; Evolution and WhatsApp are rejected.

The server creates an opaque state bound to the Connection ID, its client ID,
the authenticated actor ID, provider and channel type. The browser only sees
the state; the persisted store holds only a SHA-256 digest, expires it (default
10 minutes) and removes it atomically on the first callback attempt. The
callback accepts no client/tenant/account identifiers, preventing a browser
from selecting another tenant or Connection.

`GET /connections/meta/instagram/callback` is deliberately public because
Meta redirects the browser to it. Its state validation is the authorization
boundary. Missing, expired, wrong or reused state is rejected.

## PKCE decision

G2 uses a server-side confidential-client authorization-code flow. The Gateway
keeps `META_APP_SECRET` server-side and posts it only to Meta's token endpoint;
it never reaches the browser. PKCE is not added artificially to this flow.
If a future Meta configuration mandates PKCE, the verifier must be stored in
the same server-side state record and this decision revisited.

## Configuration and scopes

OAuth is validated lazily on authorization start, not application startup:
`META_APP_ID`, `META_APP_SECRET` and `META_REDIRECT_URI` are required then.
This preserves Evolution/WhatsApp installations that do not use Instagram.

Requested scopes are centrally configured through `INSTAGRAM_OAUTH_SCOPES`
(default: `instagram_business_basic,instagram_business_manage_messages`). The
token response scopes are persisted when Meta returns them; otherwise the
authorized requested scope set is recorded for readiness. No scope is added by
routes or frontend clients.

## Token, expiry and refresh

The authorization code exchange is server-side with an explicit timeout and no
blind retry (codes are single-use). Only token, token type, expiry and scopes
are processed; OAuth responses, authorization codes, secrets and tokens are
never logged or returned by the callback.

`expires_in` is converted to an absolute UTC `expires_at`. Credential state is
`active`, `expiring` (within seven days), `expired`, or `unknown`. G2 creates no
refresh scheduler and no fictional `refresh_token`: reauthorization is required
when the token type/expiry requires it.

## Provider account and binding

Discovery uses the authenticated token to retrieve the Instagram professional
account. Its `providerAccountId` remains an opaque string. Display metadata
such as username, display name and account type may be stored; secrets never
are.

The `ProviderAccountReference(meta, instagram, providerAccountId)` is stored in
the existing encrypted provider credential facility and bound to exactly one
Gateway Connection. Duplicate account binding to a different Connection is
rejected (including across tenants); reconnect uses the same disconnected
Connection and starts OAuth again.

## Readiness and disconnect

`GET /connections/{connection_id}/instagram/readiness` reports provider-specific
states: OAuth pending, credential missing, missing scopes, expired,
disconnected or ready. Instagram readiness never requires an instance name,
phone number or JID.

`POST /connections/{connection_id}/instagram/disconnect` is authenticated and
ownership-checked. It deletes the encrypted credential and provider-account
binding and marks the Connection disconnected. It does not delete CRM/Core
history.

## Encryption

Provider-account OAuth credentials use `PROVIDER_CREDENTIALS_ENCRYPTION_KEY`.
In production this dedicated key is mandatory; `GATEWAY_API_KEY` is not a
fallback. Development/test retain the documented compatibility fallback to the
dedicated official-credentials key and then gateway key.

## Tests and boundaries

Tests cover state randomness/single use/expiry, token and discovery mocks,
opaque IDs, credential encryption, production-key enforcement, tenant-safe
duplicate binding, readiness, disconnect and WhatsApp regression.

G3 adds webhook account resolution and reception. G4 adds Core canonical event
delivery. G5 adds outbound Instagram messaging. None is present in G2.
