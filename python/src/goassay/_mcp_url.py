"""The MCP URL shapes the Assay MCP host serves (spec section 2.3), checked when a client is built so
a typo is a ``ConfigError`` at once, not a 404 on the first call. Only the shape is checked: whether
the tool set exists, or is shared with this key, is the server's answer.

To support a new shape, add one line to ``_PATH_SHAPES`` or ``_FILTERS``.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from urllib.parse import parse_qsl

from goassay.errors import ConfigError

# The MCP origin a bare path (``"/my/research"``) resolves against.
DEFAULT_MCP_ORIGIN = "https://mcp.goassay.ai"

_SLUG = r"[a-z0-9-]{2,64}"
_HANDLE = r"[a-z][a-z0-9-]{2,23}"
_CATEGORY = r"[a-z][a-z0-9-]{1,63}"
# A link-only token: a secret, never printed (see ``redact_mcp_url``).
_TOKEN = r"[a-z0-9_-]{22,64}"
_VERSION = r"(?:@[1-9][0-9]{0,5})?"

# Paths, matched lowercased with ``%40`` read as ``@`` and one trailing slash removed.
_PATH_SHAPES = [
    re.compile(r"/"),  # Everything
    re.compile(rf"/my/{_SLUG}{_VERSION}"),  # my tool set: Draft, or version n
    re.compile(rf"/@{_HANDLE}/{_SLUG}{_VERSION}"),  # a public tool set
    re.compile(rf"/u/{_TOKEN}{_VERSION}"),  # a link-only tool set
    re.compile(rf"/c/{_CATEGORY}"),  # a topic
    re.compile(rf"/@{_HANDLE}"),  # one maker's tools
]

_TOOL_SELECTOR = re.compile(r"[a-z][a-z0-9_-]{1,47}(?:@[1-9][0-9]{0,5})?")
_CATEGORY_RE = re.compile(_CATEGORY)
_MAX_TOOLS = 50
_MAX_URL_LENGTH = 2048
# ``scheme://authority`` at the start of a full URL.
_ORIGIN = re.compile(r"^[a-z][a-z0-9+.-]*://[^/?#]*", re.I)
_LINK_TOKEN = re.compile(r"/u/[^/?#@]+", re.I)


def _items(value: str) -> list[str]:
    """A comma list, trimmed and lowercased, empty items dropped."""
    return [s for s in (part.strip().lower() for part in value.split(",")) if s]


# Query filters (they only narrow what a URL serves): name -> is this value accepted.
_FILTERS: dict[str, Callable[[str], bool]] = {
    "tools": lambda v: all(_TOOL_SELECTOR.fullmatch(t) for t in _items(v)),
    "category": lambda v: all(_CATEGORY_RE.fullmatch(c) for c in _items(v)),
    "free": lambda v: v.strip() in ("0", "1"),
    "discovery": lambda v: v.strip().lower() in ("auto", "full", "search"),
}


def _check_shape(name: str, path_and_query: str) -> None:
    if len(path_and_query) > _MAX_URL_LENGTH:
        raise ConfigError(f"{name} is too long")
    raw_path, _, query = path_and_query.partition("?")
    decoded = re.sub("%40", "@", raw_path, flags=re.I)
    if "%" in decoded:
        raise ConfigError(f"{name} has a percent-escape in its path")
    path = decoded.lower()
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    if not any(shape.fullmatch(path) for shape in _PATH_SHAPES):
        raise ConfigError(f'{name} is not an MCP URL Assay serves (see "Choose a URL")')
    tools: set[str] = set()
    for key, value in parse_qsl(query, keep_blank_values=True):
        accepts = _FILTERS.get(key)
        if accepts is None:
            raise ConfigError(f'{name} has an unknown filter "{key[:32]}"')
        if not accepts(value):
            raise ConfigError(f'{name} has an invalid "{key}" filter')
        if key == "tools":
            tools.update(_items(value))
    if len(tools) > _MAX_TOOLS:
        raise ConfigError(f"{name} names more than {_MAX_TOOLS} tools")


def resolve_mcp_url(name: str, value: str, origin: str) -> str:
    """``value`` (a full MCP URL, or a path such as ``"/my/research"`` resolved against ``origin``)
    as the URL to send to. Raises ``ConfigError`` for a path the MCP host does not serve. The URL is
    sent as given: the server reads it into its canonical form."""
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ConfigError(f"{name} is not a URL")
    if "#" in value:
        raise ConfigError(f"{name} must not have a fragment")
    if value.startswith("/"):
        if value.startswith("//"):
            raise ConfigError(f"{name} is not a URL")
        _check_shape(name, value)
        return origin + value
    # The raw text after the origin: a URL parser would quietly resolve ``.`` and ``..``.
    rest = _ORIGIN.sub("", value, count=1)
    _check_shape(name, "/" if rest == "" else f"/{rest}" if rest.startswith("?") else rest)
    return value


def redact_mcp_url(url: str) -> str:
    """``url`` with a link-only token shown as ``/u/…``: for ``repr`` and logs."""
    m = _ORIGIN.match(url)
    origin = m.group(0) if m else ""
    return origin + _LINK_TOKEN.sub("/u/…", url[len(origin) :])
