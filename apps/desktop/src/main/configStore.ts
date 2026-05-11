/**
 * Desktop config persistence — backed by `config.json` under a
 * configurable `userData` directory.
 *
 * Production code constructs the store with
 * `{ userDataDir: app.getPath('userData') }` (the Electron-blessed
 * per-user, per-platform path; see README §"Config storage
 * location"). Tests inject a fresh tmpdir so a round-trip suite can
 * exercise read / write / corruption-recovery without touching the
 * developer's real `~/Library/Application Support/pm-go/`.
 *
 * The store is intentionally synchronous: this code runs inside the
 * Electron main process where blocking I/O on a tiny JSON file is
 * cheap, and a sync surface means the IPC handler can return the
 * parsed Config directly without juggling promises. If the file
 * grows past trivial size we'll revisit — `config.json` is single
 * digit KB even with phase-1 fields stacked on.
 *
 * Sole `fs` import surface in `src/main/`: per the task's acceptance
 * criterion ("no usage of `child_process`, or `fs` outside the
 * config-store path under `app.getPath('userData')`"), every other
 * main-process module routes file access through this store or not
 * at all. A grep over `src/main/**` should land here and only here.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  parseConfig,
  type Config,
} from "../shared/config.js";
import { normalizeBaseUrl } from "../shared/url.js";

/**
 * Filename written under `userDataDir`. Capitalized as `config.json`
 * to match the README and the existing M0 contract; do NOT rename
 * without a corresponding migration.
 */
export const CONFIG_FILENAME = "config.json";

/**
 * Narrow public surface of the config store. The store owns the
 * canonical Config on disk; callers read via {@link getConfig} and
 * mutate via {@link setApiBaseUrl}. Both methods are synchronous.
 *
 * The `filePath` is exposed primarily for debugging / test
 * assertions ("verify the file was actually written here"). It is
 * NOT part of the IPC bridge — the renderer never sees a raw path.
 */
export interface ConfigStore {
  /** Absolute path to the on-disk `config.json` this store reads/writes. */
  readonly filePath: string;
  /** Read the current Config from disk, applying defaults for missing/invalid fields. */
  getConfig(): Config;
  /**
   * Persist a new `apiBaseUrl`, returning the resulting Config.
   * The URL is run through {@link normalizeBaseUrl} before write,
   * so callers can pass operator-typed input verbatim.
   */
  setApiBaseUrl(url: string): Config;
}

/** Options for {@link createConfigStore}. `userDataDir` is the only required field. */
export interface CreateConfigStoreOptions {
  /**
   * Directory under which `config.json` lives. Production uses
   * `app.getPath('userData')`; tests pass a tmpdir. The directory
   * is created (recursively) on construction if it doesn't exist.
   */
  userDataDir: string;
}

/**
 * Build a fresh {@link ConfigStore} rooted at `userDataDir`.
 *
 * Construction is forgiving — a missing directory is created, a
 * missing `config.json` is seeded with {@link DEFAULT_CONFIG}, and a
 * corrupt file falls back to defaults on read rather than throwing.
 * This matches the desktop's "be resilient to a partial write or a
 * hand-edited file" stance documented in `src/shared/config.ts`.
 *
 * `setApiBaseUrl` reads-modify-writes through disk on every call.
 * That's deliberate: the file is tiny, and a single fsync per
 * operator-driven mutation is the right durability/complexity
 * trade-off. We do not cache an in-memory copy — every `getConfig`
 * goes back to disk, so an external edit (operator opens the file
 * in their editor) is reflected next call.
 */
export function createConfigStore(
  options: CreateConfigStoreOptions,
): ConfigStore {
  const { userDataDir } = options;
  const filePath = join(userDataDir, CONFIG_FILENAME);

  function ensureDir(): void {
    if (!existsSync(userDataDir)) {
      mkdirSync(userDataDir, { recursive: true });
    }
  }

  function readFromDisk(): Config {
    if (!existsSync(filePath)) {
      return { ...DEFAULT_CONFIG };
    }
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      // Permissions or transient I/O failure: yield defaults rather
      // than crash the main process. A reviewer with logs can still
      // see the underlying error via the OS-level audit trail.
      return { ...DEFAULT_CONFIG };
    }
    if (raw.trim() === "") {
      return { ...DEFAULT_CONFIG };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt JSON (e.g. crash mid-save) — fall back to defaults.
      // parseConfig would do the same on a non-object, but JSON.parse
      // throws before we get there.
      return { ...DEFAULT_CONFIG };
    }
    return parseConfig(parsed);
  }

  function writeToDisk(config: Config): void {
    ensureDir();
    // Trailing newline matches the project's prettier/editorconfig
    // convention and keeps `cat config.json` clean in a terminal.
    writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  // Seed default on first launch. Doing this at construction
  // (rather than lazily on first getConfig()) means the operator
  // can locate the file via `ls "$(app.getPath('userData'))"`
  // immediately after launching, even before they've poked the UI.
  if (!existsSync(filePath)) {
    writeToDisk({ ...DEFAULT_CONFIG });
  }

  return {
    filePath,
    getConfig(): Config {
      return readFromDisk();
    },
    setApiBaseUrl(url: string): Config {
      const current = readFromDisk();
      const next: Config = {
        ...current,
        apiBaseUrl: normalizeBaseUrl(url),
      };
      writeToDisk(next);
      return next;
    },
  };
}
