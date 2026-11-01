"""Where the client keeps its channel lanes between runs.

A lane's record is the only source of the next cumulative the client signs, so it is written before
every signature (write-ahead) and must survive a restart: a lane forgotten and opened again from a
lower total would sign values the server already holds, and the spend guards would count them
wrongly.

- ``FileChannelStore(path)``: one JSON file, mode 0600, replaced atomically (a temporary file, fsync,
  then rename). A lock file next to it (``<path>.lock``, holding the process id) keeps a second process
  off the same record: two processes on one record could sign conflicting totals. A lock left by a
  process that is gone is taken over (POSIX); on Windows a left lock must be removed by hand.
- ``MemoryChannelStore()``: for tests and short scripts; lanes end with the process. A channel debt left
  when the process ended can then no longer be renewed by this client (``not_signed_here``): a person
  settles it in the Assay app once offered there.

A store never repairs or resets a damaged record: reading it fails, and the client then pays per call
(never by channel) until a person fixes or removes the file.
"""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import secrets
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from goassay.errors import ConfigError

# One lock per record, so several clients in one process never interleave a read-modify-write.
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


class ChannelStore(Protocol):
    """``lock`` (optional): held around every read-modify-write of the record by every client on it."""

    def load(self) -> Any:
        """The stored record (unparsed), or ``None`` when there is none yet."""

    def save(self, book: dict[str, Any]) -> None:
        """Replaces the record; durable when it returns."""


class MemoryChannelStore:
    """Lanes in memory only: a channel debt cannot be renewed after the process ends."""

    def __init__(self) -> None:
        self._value: str | None = None
        self.lock = threading.Lock()

    def load(self) -> Any:
        return None if self._value is None else json.loads(self._value)

    def save(self, book: dict[str, Any]) -> None:
        self._value = json.dumps(book)


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        return True  # no safe liveness probe: os.kill(pid, 0) sends CTRL_C_EVENT there
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _in_use() -> ConfigError:
    return ConfigError("the channel store is in use by another process; give each process its own file")


def _read(path: Path) -> tuple[int, str] | None:
    try:
        return path.stat().st_ino, path.read_text()
    except OSError:
        return None


def take_lock(lock: Path, before_takeover: Callable[[], None] | None = None) -> None:
    """Takes ``<path>.lock`` for this process, or raises ``ConfigError`` when another live process
    holds it. The lock appears with its content at once (a temporary file holding the pid is
    hard-linked to the lock name; the link fails when a lock exists). A lock whose process is gone is
    moved aside with one rename (only one contender moves a given file), checked to be the file seen
    stale (same inode and content), and the race for a fresh link starts again; a contender that
    moved a fresh lock by mistake links it back and gives up. ``before_takeover`` is a test hook."""
    mine = str(os.getpid())
    token = secrets.token_hex(8)
    for _ in range(3):
        tmp = lock.with_name(f"{lock.name}.{mine}.{token}.new")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(mine)
        try:
            os.link(tmp, lock)
        except FileExistsError:
            pass
        else:

            def release(pid: str = mine) -> None:
                try:
                    if lock.read_text() == pid:
                        lock.unlink()
                except OSError:
                    pass

            atexit.register(release)
            return
        finally:
            tmp.unlink(missing_ok=True)
        seen = _read(lock)
        if seen is None:
            continue  # gone in between: race for it again
        if seen[1].strip() == mine:
            return
        try:
            holder = int(seen[1].strip())
        except ValueError:
            holder = 0
        if holder > 0 and _alive(holder):
            raise _in_use()
        if before_takeover is not None:
            before_takeover()
        aside = lock.with_name(f"{lock.name}.{mine}.{token}.stale")
        try:
            os.rename(lock, aside)
        except OSError:
            continue  # another contender moved it first
        moved = _read(aside)
        if moved == seen:
            aside.unlink(missing_ok=True)
            continue  # the stale lock is gone: race for a fresh one
        # A fresh lock was moved by mistake: put it back where its holder expects it.
        with contextlib.suppress(OSError):
            os.link(aside, lock)
        aside.unlink(missing_ok=True)
        raise _in_use()
    raise ConfigError("the channel store lock could not be taken")


def _sync_dir(path: Path) -> None:
    """fsync of a folder, so a rename in it is durable; not possible on every platform."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


class FileChannelStore:
    """Lanes in one JSON file at ``path`` (created with its folder). The lock is taken on first use
    and held until the process exits."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        if not str(path):
            raise ConfigError("FileChannelStore needs a file path")
        self._path = Path(path)
        # The process that took the lock: a forked child holds none, whatever it inherited.
        self._locked_by: int | None = None
        self._mutex = threading.Lock()
        self.lock = _lock_for(str(self._path.resolve()))

    def _lock(self) -> None:
        with self._mutex:
            if self._locked_by == os.getpid():
                return
            self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            take_lock(self._path.with_name(self._path.name + ".lock"))
            self._locked_by = os.getpid()

    def load(self) -> Any:
        self._lock()
        try:
            text = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        return json.loads(text)

    def save(self, book: dict[str, Any]) -> None:
        self._lock()
        tmp = self._path.with_name(f"{self._path.name}.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(book, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self._path)
        _sync_dir(self._path.parent)
