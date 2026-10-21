"""Strict canonical-v2 transport DTOs. Unknown provider evidence is null."""
from typing import Literal
from pydantic import Field, StrictBool, StrictInt, StrictStr, model_validator
from app.models.canonical_outbound import (
    _CanonicalModel, CanonicalOutboundMessage, CanonicalRecipient, CanonicalTrace,
)

OpaqueId = StrictStr

class Identity(_CanonicalModel):
    externalId: OpaqueId | None
    displayName: StrictStr | None

class Chat(_CanonicalModel):
    type: Literal['direct', 'group']
    externalId: StrictStr = Field(min_length=1, max_length=255)

class Quote(_CanonicalModel):
    providerMessageId: OpaqueId | None
    author: Identity
    chatExternalId: OpaqueId | None

class Transport(_CanonicalModel):
    provider: Literal['evolution']
    channelType: Literal['whatsapp']
    providerAccountRef: StrictStr
    connectionRef: StrictStr
    coreChannelId: StrictStr
    bindingId: StrictStr

class InboundMessage(_CanonicalModel):
    providerMessageId: StrictStr = Field(min_length=1)
    kind: StrictStr
    text: StrictStr | None
    fromMe: StrictBool | None
    mentions: list[Identity] | None
    quoted: Quote | None

class CanonicalInboundV2(_CanonicalModel):
    contractVersion: Literal['canonical-v2']
    eventId: StrictStr
    eventType: Literal['message']
    occurredAt: StrictInt | None  # Unix milliseconds; never ingestion time
    transport: Transport
    chat: Chat
    author: Identity
    botAccount: Identity
    message: InboundMessage

class RecipientV2(CanonicalRecipient):
    type: Literal['direct', 'group']

class CanonicalOutboundV2(CanonicalOutboundMessage):
    contractVersion: Literal['canonical-v2']
    connectionRef: StrictStr
    bindingId: StrictStr
    recipient: RecipientV2

class GroupBindingRequest(_CanonicalModel):
    connectionRef: StrictStr
    coreChannelId: StrictStr

class GroupPolicy(_CanonicalModel):
    connectionRef: StrictStr
    coreChannelId: StrictStr
    bindingId: StrictStr
    contractVersion: Literal['canonical-v2']
    enabled: StrictBool = False
    # Explicit API profile, not a claim that live group support was verified.
    evolutionApiProfile: Literal['evolution-v2-sendText']
    authorizedGroups: list[StrictStr] = Field(max_length=1000)
    botAccount: Identity

    @model_validator(mode='after')
    def validate_groups(self):
        if any(not valid_group_id(value) for value in self.authorizedGroups):
            raise ValueError('Expected complete Evolution group JIDs')
        if len(set(self.authorizedGroups)) != len(self.authorizedGroups):
            raise ValueError('Duplicate group authorization')
        return self


def valid_group_id(value: str) -> bool:
    return bool(value and value.endswith('@g.us') and len(value) > 5 and
                len(value) <= 255 and not any(c.isspace() or ord(c) < 32 for c in value)
                and value.count('@') == 1)


class GroupReplayRequest(GroupBindingRequest):
    bindingId: StrictStr

class OutboundAccepted(_CanonicalModel):
    status: Literal['accepted']
    providerMessageId: StrictStr | None
    idempotencyKey: StrictStr
    trace: CanonicalTrace
    provider: Literal['evolution', 'meta']
