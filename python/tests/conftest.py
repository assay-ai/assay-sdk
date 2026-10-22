from __future__ import annotations

import pytest

from goassay._eip155 import reset_spend_ledger


@pytest.fixture(autouse=True)
def _fresh_spend_ledger() -> None:
    reset_spend_ledger()
