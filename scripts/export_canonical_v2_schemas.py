"""Run with PYTHONPATH=gateway python scripts/export_canonical_v2_schemas.py."""
import json
from pathlib import Path
from app.models.canonical_v2 import (
    CanonicalInboundV2, CanonicalOutboundV2, GroupPolicy,
    GroupBindingRequest, GroupReplayRequest, OutboundAccepted,
)

root = Path(__file__).resolve().parents[1] / 'docs' / 'contracts' / 'canonical-v2'
for name, model in [('inbound', CanonicalInboundV2), ('outbound', CanonicalOutboundV2),
                    ('policy', GroupPolicy), ('binding', GroupBindingRequest),
                    ('replay', GroupReplayRequest), ('accepted', OutboundAccepted)]:
    (root / f'{name}.schema.json').write_text(
        json.dumps(model.model_json_schema(by_alias=True), indent=2) + '\n', encoding='utf-8')
