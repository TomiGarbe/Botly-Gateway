"""Strict canonical-v2 transport DTOs. Unknown provider evidence is null."""

from typing import Literal

from pydantic import Field, StrictBool, StrictInt, StrictStr, model_validator

from app.models.canonical_outbound import (
    CanonicalOutboundMessage,
    CanonicalRecipient,
    CanonicalTrace,
    _CanonicalModel,
)

OpaqueId = StrictStr


class Identity(_CanonicalModel):
    externalId: OpaqueId | None
    displayName: StrictStr | None


class Chat(_CanonicalModel):
    type: Literal["direct", "group"]
    externalId: StrictStr = Field(min_length=1, max_length=255)
    displayName: StrictStr | None = Field(default=None, max_length=160)


class Quote(_CanonicalModel):
    providerMessageId: OpaqueId | None
    author: Identity
    chatExternalId: OpaqueId | None


class Transport(_CanonicalModel):
    provider: Literal["evolution"]
    channelType: Literal["whatsapp"]
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
    contractVersion: Literal["canonical-v2"]
    eventId: StrictStr
    eventType: Literal["message"]
    occurredAt: StrictInt | None  # Unix milliseconds; never ingestion time
    transport: Transport
    chat: Chat
    author: Identity
    authorPhoneNumber: StrictStr | None = Field(default=None, pattern=r"^[1-9][0-9]{6,14}$")
    botAccount: Identity
    message: InboundMessage


class RecipientV2(CanonicalRecipient):
    type: Literal["direct", "group"]


class ReplyTo(_CanonicalModel):
    providerMessageId: StrictStr = Field(min_length=1, max_length=255)
    chatExternalId: StrictStr = Field(min_length=1, max_length=255)
    authorExternalId: StrictStr = Field(min_length=1, max_length=255)
    text: StrictStr = Field(max_length=32000)
    fromMe: StrictBool = False


class CanonicalOutboundV2(CanonicalOutboundMessage):
    contractVersion: Literal["canonical-v2"]
    connectionRef: StrictStr
    bindingId: StrictStr
    recipient: RecipientV2
    replyTo: ReplyTo | None = None

    @model_validator(mode="after")
    def scoped_quote(self):
        if self.replyTo and (
            self.recipient.type != "group"
            or self.replyTo.chatExternalId != self.recipient.external_id
            or not valid_group_id(self.replyTo.chatExternalId)
        ):
            raise ValueError("Reply must belong to the destination group")
        return self


class GroupBindingRequest(_CanonicalModel):
    connectionRef: StrictStr
    coreChannelId: StrictStr


class GroupPolicy(_CanonicalModel):
    connectionRef: StrictStr
    coreChannelId: StrictStr
    bindingId: StrictStr
    contractVersion: Literal["canonical-v2"]
    enabled: StrictBool = False
    # Explicit API profile, not a claim that live group support was verified.
    evolutionApiProfile: Literal["evolution-v2-sendText"]
    authorizedGroups: list[StrictStr] = Field(max_length=1000)
    botAccount: Identity
    admission: Literal["explicit", "account"] = "explicit"
    excludedGroups: list[StrictStr] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def validate_groups(self):
        if any(not valid_group_id(value) for value in [*self.authorizedGroups, *self.excludedGroups]):
            raise ValueError("Expected complete Evolution group JIDs")
        if len(set(self.authorizedGroups)) != len(self.authorizedGroups):
            raise ValueError("Duplicate group authorization")
        return self


class DiscoveredGroup(_CanonicalModel):
    externalId: StrictStr = Field(min_length=1, max_length=255)
    displayName: StrictStr = Field(min_length=1, max_length=160)


class AutomaticRegistration(_CanonicalModel):
    connectionRef: StrictStr = Field(min_length=1, max_length=255)
    coreChannelId: StrictStr
    gatewayClientId: StrictStr = Field(min_length=1, max_length=255)
    providerAccountRef: StrictStr = Field(min_length=1, max_length=255)
    botExternalIds: list[StrictStr] = Field(max_length=8)
    groups: list[DiscoveredGroup] = Field(max_length=1000)


class AutomaticRequest(_CanonicalModel):
    coreChannelId: StrictStr
    connectionRef: StrictStr = Field(min_length=1, max_length=255)


class HistoryPageRequest(_CanonicalModel):
    coreChannelId: StrictStr
    connectionRef: StrictStr = Field(min_length=1, max_length=255)
    page: int = Field(ge=1, le=100000)
    pageSize: int = Field(default=200, ge=1, le=500)
    cursor: StrictStr | None = Field(default=None, max_length=1024)


def valid_group_id(value: str) -> bool:
    return bool(
        value
        and value.endswith("@g.us")
        and len(value) > 5
        and len(value) <= 255
        and not any(c.isspace() or ord(c) < 32 for c in value)
        and value.count("@") == 1
    )


class GroupReplayRequest(GroupBindingRequest):
    bindingId: StrictStr


class OutboundAccepted(_CanonicalModel):
    status: Literal["accepted"]
    providerMessageId: StrictStr | None
    idempotencyKey: StrictStr
    trace: CanonicalTrace
    provider: Literal["evolution", "meta"]
