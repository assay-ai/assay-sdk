"""The Assay SDK: call tools over MCP, with free calls and paid calls signed by a key you hold."""

__version__ = "0.0.0"

from goassay import errors  # noqa: E402
from goassay._client import (  # noqa: E402
    DEFAULT_API_URL,
    DEFAULT_MCP_URL,
    Assay,
    AsyncAssay,
)
from goassay._paid_calls import PaidCallsStatus  # noqa: E402
from goassay._tools import SearchResult, ToolResult  # noqa: E402
from goassay.errors import (  # noqa: E402
    AssayError,
    AuthError,
    ConfigError,
    NetworkError,
    PaymentError,
    PaymentRefusedError,
    PaymentRequiredError,
    PaymentSchemeUnsupportedError,
    RateLimitError,
    ScopeMissingError,
    ServerError,
    TimeoutError,
)
from goassay.signers import EvmSigner, Signer, evm_signer  # noqa: E402

__all__ = [
    "DEFAULT_API_URL",
    "DEFAULT_MCP_URL",
    "Assay",
    "AssayError",
    "AsyncAssay",
    "AuthError",
    "ConfigError",
    "EvmSigner",
    "NetworkError",
    "PaidCallsStatus",
    "PaymentError",
    "PaymentRefusedError",
    "PaymentRequiredError",
    "PaymentSchemeUnsupportedError",
    "RateLimitError",
    "ScopeMissingError",
    "SearchResult",
    "ServerError",
    "Signer",
    "TimeoutError",
    "ToolResult",
    "errors",
    "evm_signer",
]
