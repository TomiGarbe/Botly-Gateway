from app.models.observability import COMMON_SEMANTIC_STATUSES, ObservabilityEvent


def test_common_observability_contract_keeps_delivery_domains_read_only() -> None:
    webhook: ObservabilityEvent = {
        "id": "webhook-1", "operation": "webhook.delivery",
        "semanticStatus": "success", "source": {"service": "gateway"},
        "destination": {"type": "webhook"}, "request": {}, "response": {},
        "metadata": {"webhookId": "hook-1"},
    }
    provider: ObservabilityEvent = {
        "id": "provider-1", "operation": "provider.message.outbound",
        "semanticStatus": "network_error", "source": {"kind": "gateway"},
        "destination": {"kind": "provider"}, "request": {}, "response": {},
        "metadata": {"messageId": "message-1"},
    }

    assert webhook["operation"] != provider["operation"]
    assert webhook["semanticStatus"] in COMMON_SEMANTIC_STATUSES
    assert provider["semanticStatus"] in COMMON_SEMANTIC_STATUSES
