from __future__ import annotations

from typing import Any

# The binding proof's own EIP-712 domain (spec section 5). Not the escrow's.
DELEGATE_BINDING_DOMAIN_NAME = "GoAssay Agent Binding"
DELEGATE_BINDING_DOMAIN_VERSION = "1"

# The longest challenge life a client accepts: the server's challenge TTL.
MAX_BINDING_CHALLENGE_SECONDS = 300

# Exactly these fields, in this order. The order is part of the type hash.
DELEGATE_BINDING_TYPES: dict[str, list[dict[str, str]]] = {
    "DelegateBinding": [
        {"name": "delegate", "type": "address"},
        {"name": "credentialId", "type": "string"},
        {"name": "nonce", "type": "string"},
        {"name": "expiresAt", "type": "uint64"},
    ],
}


def binding_typed_data(chain_id: int, delegate: str, credential_id: str, nonce: str, expires_at: int) -> dict[str, Any]:
    """The typed data for checked values. The field-by-field challenge check lands with the client."""
    return {
        "domain": {
            "name": DELEGATE_BINDING_DOMAIN_NAME,
            "version": DELEGATE_BINDING_DOMAIN_VERSION,
            "chainId": chain_id,
        },
        "types": DELEGATE_BINDING_TYPES,
        "primaryType": "DelegateBinding",
        "message": {
            "delegate": delegate,
            "credentialId": credential_id,
            "nonce": nonce,
            "expiresAt": expires_at,
        },
    }
