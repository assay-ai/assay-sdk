"""The SDK's errors.

Every error the SDK raises is an :class:`AssayError` with a stable ``code``; branch on the class
or on ``code``, never on the message. A server code this release does not know still arrives,
as the nearest class (or ``AssayError`` itself)::

    AssayError
    ├─ ConfigError                       local setup (missing API key, bad option)
    ├─ AuthError                         401, or an AUTH_* refusal
    │   └─ ScopeMissingError             403 AUTH_SCOPE_MISSING (.required_scope)
    ├─ PaymentError                      a PAYMENT_* refusal from the server
    │   ├─ PaymentRequiredError          the tool is paid and no signer was given (.requirement)
    │   ├─ PaymentSchemeUnsupportedError no signer for the requirement's network (.network)
    │   └─ PaymentRefusedError           refused locally before signing (.guard); nothing signed
    ├─ RateLimitError                    429, RATE_LIMITED, quota or velocity limits (.retry_after)
    ├─ NetworkError                      no answer: connection failure
    │   └─ TimeoutError
    └─ ServerError                       5xx or an answer the SDK cannot read
"""

from __future__ import annotations

from typing import Any


class AssayError(Exception):
    """Base class. ``code`` is stable; ``retryable`` says whether the same call can succeed later."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        status: int | None = None,
        fix_url: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status = status
        self.fix_url = fix_url
        self.details = details


class ConfigError(AssayError):
    def __init__(self, message: str) -> None:
        super().__init__("CONFIG_INVALID", message)


class AuthError(AssayError):
    pass


class ScopeMissingError(AuthError):
    def __init__(self, message: str, *, required_scope: str | None = None, **kw: Any) -> None:
        kw.setdefault("status", 403)
        super().__init__("AUTH_SCOPE_MISSING", message, **kw)
        self.required_scope = required_scope


class PaymentError(AssayError):
    pass


class PaymentRequiredError(PaymentError):
    def __init__(self, message: str, requirement: Any, *, fix_url: str | None = None) -> None:
        super().__init__("PAYMENT_REQUIRED", message, fix_url=fix_url)
        self.requirement = requirement


class PaymentSchemeUnsupportedError(PaymentError):
    def __init__(self, network: str) -> None:
        super().__init__(
            "PAYMENT_SCHEME_UNSUPPORTED", f"no signer for network {network}; pass a signer for this network"
        )
        self.network = network


class PaymentRefusedError(PaymentError):
    def __init__(self, guard: str, code: str, reason: str, *, fix_url: str | None = None) -> None:
        super().__init__(code, f"payment refused before signing: {reason}", fix_url=fix_url)
        self.guard = guard


class RateLimitError(AssayError):
    def __init__(self, code: str, message: str, *, retry_after: float | None = None, **kw: Any) -> None:
        kw.setdefault("retryable", True)
        super().__init__(code, message, **kw)
        self.retry_after = retry_after
        """Seconds to wait before trying again, when the server said."""


class NetworkError(AssayError):
    def __init__(self, message: str, code: str = "NETWORK_ERROR") -> None:
        super().__init__(code, message, retryable=True)


class TimeoutError(NetworkError):  # noqa: A001 - the SDK's own, scoped under goassay.errors
    def __init__(self, message: str = "the request timed out") -> None:
        super().__init__(message, "TIMEOUT")


class ServerError(AssayError):
    pass


_RATE_LIMIT_CODES = {"RATE_LIMITED", "TOO_MANY_REQUESTS", "MCP_QUOTA_EXCEEDED", "MCP_VELOCITY_LIMIT_EXCEEDED"}


def error_from_server(
    code: str | None,
    message: str,
    *,
    status: int | None = None,
    retryable: bool = False,
    fix_url: str | None = None,
    details: dict[str, Any] | None = None,
    retry_after: float | None = None,
) -> AssayError:
    """The typed error for a server refusal, chosen by code first, then by HTTP status."""
    c = code or (f"HTTP_{status}" if status is not None else "UNKNOWN")
    kw: dict[str, Any] = {"status": status, "fix_url": fix_url, "details": details}
    if c == "AUTH_SCOPE_MISSING":
        scope = (details or {}).get("requiredScope")
        return ScopeMissingError(message, required_scope=scope if isinstance(scope, str) else None, **kw)
    if c in _RATE_LIMIT_CODES or status == 429:
        return RateLimitError(c, message, retry_after=retry_after, **kw)
    if c.startswith("AUTH_") or status == 401:
        return AuthError(c, message, retryable=retryable, **kw)
    if c.startswith("PAYMENT_"):
        return PaymentError(c, message, retryable=retryable, **kw)
    if status is not None and status >= 500:
        return ServerError(c, message, retryable=True, **kw)
    return AssayError(c, message, retryable=retryable, **kw)
