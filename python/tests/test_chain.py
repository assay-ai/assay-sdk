"""The chain reader's agreement and retry rules: one pinned block, every RPC, identical bytes; a
transient failure reruns the whole read (3 attempts), a disagreement never does."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
from eth_utils.crypto import keccak

from goassay import PaymentRefusedError
from goassay._chain import (
    MAX_BLOCK_SPREAD,
    READ_ATTEMPTS,
    RETRY_DELAYS,
    RETRY_WINDOW,
    ChainNetwork,
    ChainReader,
)
from goassay._ops import HttpOp, HttpResult, SleepOp
from tests.fake import TOOL, Answer, Fake, Seen, get_tool_answer, payment_required, tool_result

# Public anvil default accounts (test only).
PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
DELEGATE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ESCROW = "0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f"
A = "https://rpc-a.example.test/"
B = "https://rpc-b.example.test/"
NET = ChainNetwork("eip155:46630", 46630, ESCROW, (A, B))


def _word(n: int) -> str:
    return format(n, "x").rjust(64, "0")


def _selector(sig: str) -> str:
    return keccak(text=sig)[:4].hex()


def _encode(words: list[int]) -> str:
    return "0x" + "".join(_word(w) for w in words)


@dataclass
class Rpc:
    height: int = 1000
    chain_id: int = 46630
    fail_next: int = 0  # the next this many requests answer HTTP 503
    delegate_cap: int = 500_000  # effectiveCapsOf's delegate cap (a disagreeing RPC changes it)
    calls: list[tuple[str, str | None]] = field(default_factory=list)

    def answer(self, body: dict[str, Any]) -> HttpResult:
        method = body["method"]
        self.calls.append((method, body["params"][1] if method == "eth_call" else None))
        if self.fail_next > 0:
            self.fail_next -= 1
            return HttpResult(503, {}, "{}")
        if method == "eth_chainId":
            result = hex(self.chain_id)
        elif method == "eth_blockNumber":
            result = hex(self.height)
        else:
            data = body["params"][0]["data"]
            if data.startswith("0x" + _selector("escrowOf(address)")):
                result = _encode([50_000_000, 3, 1, 1_000_000, 10_000_000, 0, 0, 0, 0, 0, 0, 50_000_000])
            elif data.startswith("0x" + _selector("effectiveCapsOf(address,address)")):
                result = _encode([1_000_000, 10_000_000, self.delegate_cap, 5_000_000])
            else:
                result = _encode([500_000, 5_000_000, 0, 0, 1_788_591_800, 0, 0])
        return HttpResult(200, {}, json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}))

    def rounds(self) -> int:
        return sum(1 for m, _ in self.calls if m == "eth_chainId")

    def blocks(self) -> set[str | None]:
        return {b for m, b in self.calls if m == "eth_call"}


@dataclass
class Harness:
    a: Rpc = field(default_factory=Rpc)
    b: Rpc = field(default_factory=Rpc)
    slept: list[float] = field(default_factory=list)
    on_sleep: Callable[[], None] = lambda: None
    clock: Callable[[], float] | None = None

    def read(self) -> dict[str, Any] | None:
        reader = ChainReader(lambda: 1_000.0, **({"monotonic": self.clock} if self.clock else {}))
        flow = reader.read(NET, PAYER, DELEGATE)
        rpcs = {A: self.a, B: self.b}
        answer: Any = None
        while True:
            try:
                op = flow.send(answer)
            except StopIteration as stop:
                return stop.value  # type: ignore[no-any-return]
            if isinstance(op, HttpOp):
                assert op.body is not None
                answer = rpcs[op.url].answer(json.loads(op.body))
            else:
                assert isinstance(op, SleepOp)
                self.slept.append(op.seconds)
                self.on_sleep()
                answer = None


def test_the_limits() -> None:
    assert MAX_BLOCK_SPREAD == 120
    assert READ_ATTEMPTS == 3
    assert RETRY_DELAYS == (0.3, 1.0)
    assert RETRY_WINDOW == 5.0


def test_agreeing_rpcs_read_at_min_height_minus_one() -> None:
    h = Harness()
    value = h.read()
    assert value is not None and value["active"] and value["delegateMaxVoucherAmount"] == "500000"
    assert h.a.blocks() == h.b.blocks() == {hex(999)}
    assert h.slept == []


def test_rpcs_100_blocks_apart_still_read() -> None:
    h = Harness()
    h.a.height = 1100
    assert h.read() is not None
    assert h.a.blocks() == h.b.blocks() == {hex(999)}


def test_rpcs_121_blocks_apart_refuse_after_every_attempt_with_no_eth_call() -> None:
    h = Harness()
    h.a.height = 1121
    assert h.read() is None
    assert h.a.blocks() == h.b.blocks() == set()
    assert h.a.rounds() == 3
    assert h.slept == [0.3, 1.0]


def test_heights_that_catch_up_read_at_the_new_pinned_block() -> None:
    h = Harness()
    h.a.height = 1200

    def catch_up() -> None:
        h.b.height = 1150

    h.on_sleep = catch_up
    assert h.read() is not None
    assert h.slept == [0.3]
    assert h.a.blocks() == h.b.blocks() == {hex(1149)}


def test_a_failure_on_attempt_1_then_an_answer_on_attempt_2_reads() -> None:
    h = Harness()
    h.b.fail_next = 1
    assert h.read() is not None
    assert h.slept == [0.3]
    assert h.a.rounds() == 2 and h.b.rounds() == 2


def test_failing_on_every_attempt_gives_no_read() -> None:
    h = Harness()
    h.b.fail_next = 100
    assert h.read() is None
    assert h.slept == [0.3, 1.0]
    assert h.a.rounds() == 3


def test_a_disagreement_at_the_pinned_block_is_final() -> None:
    h = Harness()
    h.b.delegate_cap = 900_000
    assert h.read() is None
    assert h.a.blocks() == h.b.blocks() == {hex(999)}
    assert h.slept == []
    assert h.a.rounds() == 1 and h.b.rounds() == 1


def test_another_chain_is_final() -> None:
    h = Harness()
    h.b.chain_id = 1
    assert h.read() is None
    assert h.slept == []


def test_no_new_attempt_after_the_retry_window() -> None:
    ticks = iter(range(0, 1000, int(RETRY_WINDOW)))
    h = Harness(clock=lambda: float(next(ticks)))
    h.b.fail_next = 100
    assert h.read() is None
    assert h.slept == []


def _paid(params: dict[str, Any], _seen: Seen) -> Any:
    if params["name"] == "get_tool":
        return get_tool_answer()
    if "assay/voucher" not in params["_meta"]:
        return payment_required()
    return tool_result({"assay/receipt": {"intentId": "r"}})


@pytest.mark.parametrize("asynchronous", [False, True])
def test_a_paid_call_with_no_chain_read_says_try_again_in_a_minute(asynchronous: bool) -> None:
    import asyncio

    fake = Fake(mcp=_paid, rpc=lambda s: Answer({}, 503))
    with pytest.raises(PaymentRefusedError) as err:
        if asynchronous:
            asyncio.run(fake.async_client().tools.call(TOOL, {}))
        else:
            fake.client().tools.call(TOOL, {})
    assert (err.value.guard, err.value.code) == ("G4", "G4_NO_CHAIN_READ")
    assert str(err.value).endswith(
        "payment refused before signing: the payment key's grant could not be read from the chain;"
        " try again in a minute"
    )
    assert 0.3 in fake.sleeps and 1.0 in fake.sleeps
    assert fake.signer.calls == 0
