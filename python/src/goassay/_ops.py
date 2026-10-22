"""The I/O a flow asks for. Flows are generators that yield these and get the answer back, so one
flow serves both the sync and the async client (the drivers in ``_client.py`` do the I/O)."""

from __future__ import annotations

from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from typing import Any, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class HttpOp:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None
    timeout: float


@dataclass(frozen=True)
class HttpResult:
    status: int
    headers: dict[str, str]  # lower-case names
    text: str


@dataclass(frozen=True)
class SleepOp:
    seconds: float


@dataclass(frozen=True)
class CallOp:
    """Calls a caller-supplied function (a signer, the ``on_payment`` hook); awaits it when async."""

    fn: Callable[..., Any]
    args: tuple[Any, ...] = field(default_factory=tuple)


Op = HttpOp | SleepOp | CallOp
Flow = Generator[Op, Any, T]


def http(op: HttpOp) -> Flow[HttpResult]:
    result = yield op
    assert isinstance(result, HttpResult)
    return result


def sleep(seconds: float) -> Flow[None]:
    yield SleepOp(seconds)


def call(fn: Callable[..., Any], *args: Any) -> Flow[Any]:
    return (yield CallOp(fn, args))
