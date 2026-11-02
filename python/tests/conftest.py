from __future__ import annotations

from pathlib import Path

import pytest

from goassay._eip155 import reset_spend_ledger


@pytest.fixture(autouse=True)
def _fresh_spend_ledger() -> None:
    reset_spend_ledger()


@pytest.fixture(autouse=True)
def fresh_home(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A client without ``channels=`` keeps its lanes under the home folder: never the real one."""
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    return home
