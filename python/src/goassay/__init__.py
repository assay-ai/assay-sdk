"""The Assay SDK: call tools over MCP, with free calls and paid calls signed by a key you hold."""

__version__ = "0.1.3"

from goassay import errors  # noqa: E402
from goassay._client import (  # noqa: E402
    DEFAULT_API_URL,
    DEFAULT_MCP_URL,
    DEFAULT_WEB_URL,
    Assay,
    AsyncAssay,
)
from goassay._networks import BUILT_IN_NETWORKS  # noqa: E402
from goassay._paid_calls import PaidCallsStatus  # noqa: E402
from goassay._tools import SearchResult, ToolList, ToolResult  # noqa: E402
from goassay.errors import (  # noqa: E402
    AssayError,
    AuthError,
    ConfigError,
    DelegateAlreadyBoundError,
    DelegateBindConflictError,
    HumanSessionRequiredError,
    McpUrlNotFoundError,
    NetworkError,
    PaymentError,
    PaymentNetworkUnknownError,
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
    "BUILT_IN_NETWORKS",
    "DEFAULT_API_URL",
    "DEFAULT_MCP_URL",
    "DEFAULT_WEB_URL",
    "Assay",
    "AssayError",
    "AsyncAssay",
    "AuthError",
    "ConfigError",
    "DelegateAlreadyBoundError",
    "DelegateBindConflictError",
    "EvmSigner",
    "HumanSessionRequiredError",
    "McpUrlNotFoundError",
    "NetworkError",
    "PaidCallsStatus",
    "PaymentError",
    "PaymentNetworkUnknownError",
    "PaymentRefusedError",
    "PaymentRequiredError",
    "PaymentSchemeUnsupportedError",
    "RateLimitError",
    "ScopeMissingError",
    "SearchResult",
    "ServerError",
    "Signer",
    "TimeoutError",
    "ToolList",
    "ToolResult",
    "errors",
    "evm_signer",
]
