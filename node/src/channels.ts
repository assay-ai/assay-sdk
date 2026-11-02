/**
 * Where the client keeps its channel lanes between runs. A lane's record is the only source of the
 * next cumulative the client signs, so it is written before every signature (write-ahead) and
 * must survive a restart: a lane forgotten and opened again from a lower total would sign values
 * the server already holds, and the spend guards would count them wrongly.
 *
 * - `fileChannelStore(path)`: one JSON file, mode 0600, replaced atomically (write a temporary
 *   file, then rename). A lock file next to it (`<path>.lock`, holding the process id) keeps a
 *   second process off the same record: two processes on one record could sign conflicting
 *   totals. A lock left by a process that is gone is taken over.
 * - `memoryChannelStore()`: for tests and short scripts; lanes end with the process (each run
 *   then opens new lanes, which is safe, only less efficient). A channel debt left when the
 *   process ended can then no longer be renewed by this client (`not_signed_here`): a person
 *   settles it in the Assay app once offered there.
 *
 * Without a `channels` option the client uses {@link defaultChannelStore}: a file store at
 * {@link defaultChannelStorePath} (one file per signing key). A runtime without a file system
 * (a Cloudflare Worker, an edge function, a browser) must pass `channels: { store }`.
 *
 * A store never repairs or resets a damaged record: reading it fails, and the client then pays
 * per call (never by channel) until the file is fixed or removed by a person.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  statSync,
  openSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { ConfigError } from "./errors.js";
import type { ChannelBook } from "./core/channel.js";

export interface ChannelStore {
  /** The stored record (unparsed), or `null` when there is none yet. */
  load(): Promise<unknown>;
  /** Replaces the record. Must be durable when it returns. */
  save(book: ChannelBook): Promise<void>;
  /**
   * Runs `fn` with this record to itself in the process: every client on the record (each
   * `Assay`, every `at()` sibling) reads, changes and writes it one at a time. Without it, a
   * client serialises only its own calls.
   */
  exclusive?<T>(fn: () => Promise<T>): Promise<T>;
}

/** One queue per record, so several clients in one process never interleave a read-modify-write. */
const QUEUES = new Map<string, Promise<unknown>>();

function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (QUEUES.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  QUEUES.set(key, tail);
  void tail.then(() => {
    if (QUEUES.get(key) === tail) QUEUES.delete(key);
  });
  return run;
}

let memoryStores = 0;

/** Lanes in memory only: a channel debt cannot be renewed after the process ends. */
export function memoryChannelStore(): ChannelStore {
  let value: string | null = null;
  const key = `memory:${++memoryStores}`;
  return {
    exclusive: (fn) => queued(key, fn),
    async load() {
      return value === null ? null : (JSON.parse(value) as unknown);
    },
    async save(book) {
      value = JSON.stringify(book);
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const inUse = () =>
  new ConfigError(
    "the channel store is in use by another process (paid calls are signed per call meanwhile); give each process its own file",
  );

/**
 * Takes `<path>.lock` for this process, or throws `ConfigError` when another live process holds it.
 *
 * - The lock appears with its content at once: a temporary file holding the pid is hard-linked to
 *   the lock name (the link fails when a lock exists), so no one ever reads a half-written lock.
 * - A lock whose process is gone is taken over by moving it aside with one rename (only one of
 *   several contenders moves a given file), checking that the file moved is the one seen stale
 *   (same inode and content), and then racing for a fresh link again. A contender that moved a
 *   fresh lock by mistake links it back and gives up.
 *
 * `beforeTakeover` is a test hook, run between seeing a stale lock and moving it aside.
 */
export function takeChannelStoreLock(lockPath: string, beforeTakeover?: () => void): void {
  const mine = String(process.pid);
  const token = randomBytes(8).toString("hex");
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = `${lockPath}.${mine}.${token}.new`;
    writeFileSync(tmp, mine, { mode: 0o600 });
    try {
      linkSync(tmp, lockPath);
      const release = () => {
        try {
          if (readFileSync(lockPath, "utf8") === mine) rmSync(lockPath);
        } catch {
          // Already gone.
        }
      };
      process.once("exit", release);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
    let seen: { ino: number; text: string };
    try {
      seen = { ino: statSync(lockPath).ino, text: readFileSync(lockPath, "utf8") };
    } catch {
      continue; // gone in between: race for it again
    }
    if (seen.text.trim() === mine) return;
    const holder = Number(seen.text.trim());
    if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) throw inUse();
    beforeTakeover?.();
    const aside = `${lockPath}.${mine}.${token}.stale`;
    try {
      renameSync(lockPath, aside);
    } catch {
      continue; // another contender moved it first
    }
    let moved: { ino: number; text: string } | null;
    try {
      moved = { ino: statSync(aside).ino, text: readFileSync(aside, "utf8") };
    } catch {
      moved = null;
    }
    if (moved !== null && moved.ino === seen.ino && moved.text === seen.text) {
      rmSync(aside, { force: true });
      continue; // the stale lock is gone: race for a fresh one
    }
    // A fresh lock was moved by mistake: put it back where its holder expects it.
    try {
      linkSync(aside, lockPath);
    } catch {
      // A third lock appeared meanwhile; it stands.
    }
    rmSync(aside, { force: true });
    throw inUse();
  }
  throw new ConfigError("the channel store lock could not be taken");
}

/** fsync of a folder, so a rename in it is durable; not possible on every platform. */
function syncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Windows cannot open a folder for fsync.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The real path of `path`, symlinks followed, so two spellings of one file share one queue. A file
 * (or folder) that does not exist yet: the real path of its nearest existing folder, plus the rest.
 */
function canonicalPath(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(canonicalPath(parent), basename(full));
  }
}

/**
 * Lanes in one JSON file at `path` (created with its folder, mode 0700/0600). The lock is taken
 * on first use and held until the process exits.
 */
export function fileChannelStore(path: string): ChannelStore {
  if (typeof path !== "string" || path.length === 0) throw new ConfigError("fileChannelStore needs a file path");
  let locked = false;
  // The queue key is the real path, fixed on first use (the folder may not exist before).
  let key: string | null = null;
  const queueKey = () => (key ??= `file:${canonicalPath(path)}`);
  const lock = () => {
    if (locked) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    takeChannelStoreLock(`${path}.lock`);
    locked = true;
  };
  return {
    exclusive: (fn) => queued(queueKey(), fn),
    async load() {
      lock();
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      return JSON.parse(text) as unknown;
    },
    async save(book) {
      lock();
      const tmp = `${path}.${process.pid}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(book, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      syncDir(dirname(path));
    },
  };
}

/** The config folder name of the SDK under the platform's per-user config folder. */
export const SDK_DIR_NAME = "goassay";

/**
 * The default lane file for a signing key: `{config}/goassay/channels/{address}.json`, where
 * `{config}` is `~/Library/Application Support` (macOS), `%USERPROFILE%\AppData\Roaming`
 * (Windows) or `~/.config` (other systems), and `{address}` is the key's address in lower case.
 * The Python client uses the same file, with the same lock.
 */
export function defaultChannelStorePath(
  address: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new ConfigError("the signer address is not an EVM address");
  const name = `${address.toLowerCase()}.json`;
  if (platform === "win32") return win32.join(home, "AppData", "Roaming", SDK_DIR_NAME, "channels", name);
  const base = platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
  return join(base, SDK_DIR_NAME, "channels", name);
}

/** Why this runtime has no durable file system for lanes, or `null` when it has one. */
export function noFileSystemReason(
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): string | null {
  const nav = g.navigator as { userAgent?: unknown } | undefined;
  if (nav?.userAgent === "Cloudflare-Workers") return "a Cloudflare Worker";
  if (g.EdgeRuntime !== undefined) return "an edge runtime";
  if (g.window !== undefined && g.document !== undefined) return "a browser";
  const proc = g.process as { versions?: { node?: unknown } } | undefined;
  if (typeof proc?.versions?.node !== "string") return "a runtime without Node's file system";
  return null;
}

/**
 * The store a client uses when it is given no `channels` option: {@link fileChannelStore} at
 * {@link defaultChannelStorePath} for the key. Throws `ConfigError` on a runtime without a durable
 * file system: lanes must survive a restart, so the caller passes `channels: { store }` there.
 */
export function defaultChannelStore(address: string): ChannelStore {
  const reason = noFileSystemReason();
  let home = "";
  if (reason === null) {
    try {
      home = homedir();
    } catch {
      home = "";
    }
  }
  if (reason !== null || home === "") {
    throw new ConfigError(
      `channel vouchers need a durable store for their lanes and ${reason ?? "this runtime has no home folder"} has none: pass channels: { store } (a store you keep durable)`,
    );
  }
  return fileChannelStore(defaultChannelStorePath(address, home));
}
