/**
 * `pm-go decompose` — Layer-A milestone-decomposition CLI.
 *
 * Submits a local spec file to a *running* pm-go API, kicks off the
 * `SpecDecompositionWorkflow`, polls until the manifest is `ready`,
 * optionally lets the operator edit it in `$VISUAL` / `$EDITOR`, and
 * (unless `--manifest-only`) starts a `SpecToPlanWorkflow` for the
 * first milestone.
 *
 * This command does NOT boot Docker / API / worker — it requires the
 * stack to already be running (use `pm-go run` first). The probe
 * against `<api>/health` fails fast with the canonical
 * `[pm-go] port <port> is held by another service` message if it is
 * not.
 */
import {
  PmGoIdentityMismatchError,
  probePmGoApi,
} from "./lib/api-client.js";
import { waitFor } from "./lib/wait-for.js";

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export interface DecomposeOptions {
  /** Local repo path to capture as a RepoSnapshot. */
  repoRoot: string;
  /** Local spec markdown file to upload as a SpecDocument body. */
  specPath: string;
  /** Optional spec title — defaults to the spec filename. */
  title?: string;
  /** Edit the manifest interactively before plan-first. */
  edit: boolean;
  /** Stop after printing (or PUT-saving) the manifest. */
  manifestOnly: boolean;
  /** API base URL (e.g. http://localhost:3001). */
  apiUrl: string;
}

export interface ParsedDecomposeArgv {
  ok: true;
  options: DecomposeOptions;
}

export interface DecomposeArgvError {
  ok: false;
  error: string;
}

const DEFAULT_API_PORT = 3001;

/**
 * Optional context the parser needs to make `--repo` / `--spec` work
 * with relative paths under invocation modes where `process.cwd()` is
 * not the directory the operator typed the command in (e.g. `pnpm
 * --filter @pm-go/cli exec` lands in `apps/cli`). `cwd` defaults to
 * `process.cwd()` and `resolve` to a no-op so unit tests that pass
 * absolute paths can keep using the simple form.
 */
export interface ParseDecomposeContext {
  /** Caller cwd — typically `INIT_CWD ?? process.cwd()`. */
  cwd?: string;
  /** Path resolver. Defaults to identity (callers pass absolutes). */
  resolve?: (base: string, p: string) => string;
}

export function parseDecomposeArgv(
  argv: readonly string[],
  ctx: ParseDecomposeContext = {},
): ParsedDecomposeArgv | DecomposeArgvError {
  const cwd = ctx.cwd ?? process.cwd();
  const resolve = ctx.resolve ?? ((_base, p) => p);

  let repoRoot: string | undefined;
  let specPath: string | undefined;
  let title: string | undefined;
  let edit = false;
  let manifestOnly = false;
  let port: number | undefined;
  let apiUrl: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--repo":
        if (!value) return { ok: false, error: `${flag} requires a path` };
        repoRoot = resolve(cwd, value);
        i += 1;
        break;
      case "--spec":
        if (!value) return { ok: false, error: `${flag} requires a path` };
        specPath = resolve(cwd, value);
        i += 1;
        break;
      case "--title":
        if (!value) return { ok: false, error: `${flag} requires a value` };
        title = value;
        i += 1;
        break;
      case "--edit":
        edit = true;
        break;
      case "--manifest-only":
        manifestOnly = true;
        break;
      case "--port":
      case "-p": {
        if (!value) return { ok: false, error: `${flag} requires a number` };
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return { ok: false, error: `${flag} must be an integer 1..65535` };
        }
        port = n;
        i += 1;
        break;
      }
      case "--api-url":
        if (!value) return { ok: false, error: `${flag} requires a URL` };
        apiUrl = value.replace(/\/+$/, "");
        i += 1;
        break;
      case "--help":
      case "-h":
        return { ok: false, error: "help" };
      default:
        return { ok: false, error: `unknown flag: ${flag ?? ""}` };
    }
  }

  if (!repoRoot) return { ok: false, error: "--repo <path> is required" };
  if (!specPath) return { ok: false, error: "--spec <path> is required" };

  const resolvedUrl =
    apiUrl ?? `http://localhost:${port ?? DEFAULT_API_PORT}`;

  const opts: DecomposeOptions = {
    repoRoot,
    specPath,
    edit,
    manifestOnly,
    apiUrl: resolvedUrl,
  };
  if (title !== undefined) opts.title = title;

  return { ok: true, options: opts };
}

// ---------------------------------------------------------------------------
// Side-effect deps (injected so unit tests can drive every branch).
// ---------------------------------------------------------------------------

export interface DecomposeDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  errLog: (line: string) => void;
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, contents: string) => Promise<void>;
  /**
   * Materialize a tempfile path the operator can edit. Caller is
   * responsible for cleaning the file up; we don't require a cleanup
   * hook because the spike tolerates an orphan editor file in /tmp.
   */
  makeTempfile: (suggestedName: string) => Promise<string>;
  /**
   * Spawn an interactive editor at `path`. Resolves when the editor
   * exits 0; throws otherwise. The implementation chooses `$VISUAL`,
   * then `$EDITOR`, then `vi`.
   */
  openEditor: (path: string) => Promise<void>;
  /**
   * `path.basename(p, ext?)`. Indirected so tests can assert the
   * default-title path without reaching for node:path.
   */
  basename: (p: string, ext?: string) => string;
}

export interface DecomposeCliDeps {
  argv: readonly string[];
  /**
   * Caller cwd (typically `INIT_CWD ?? process.cwd()`). Used to
   * resolve `--repo` / `--spec` relative paths against the directory
   * the operator actually typed the command in, mirroring `run` /
   * `implement`. Optional for the existing single-arg test pattern;
   * the production dispatcher always passes it.
   */
  cwd?: string;
  resolve?: (base: string, p: string) => string;
  log: (line: string) => void;
  errLog: (line: string) => void;
  buildDecomposeDeps: () => DecomposeDeps;
}

export const DECOMPOSE_USAGE = `Usage: pm-go decompose --repo <path> --spec <path> [options]

Submit a local spec to a running pm-go API, run the Layer-A milestone
decomposer, optionally edit the manifest, and start a plan for the
first milestone.

Required:
  --repo <path>      Repo root to capture as a RepoSnapshot.
  --spec <path>      Local spec markdown file to upload.

Options:
  --title <title>    Spec title (defaults to the spec filename).
  --edit             Open the manifest in $VISUAL / $EDITOR / vi before
                     starting the first plan; saves edits via
                     PUT /spec-documents/:id/decompositions/:id/manifest.
  --manifest-only    Stop after the manifest is ready (no plan-first).
  -p, --port <n>     API port (default 3001).
  --api-url <url>    Full base URL; overrides --port.
  -h, --help         Show this message.

Examples:
  pm-go decompose --repo . --spec ./spec.md
  pm-go decompose --repo . --spec ./spec.md --edit
  pm-go decompose --repo . --spec ./spec.md --manifest-only`;

// ---------------------------------------------------------------------------
// Tunable timing constants (small for tests; production callers override).
// ---------------------------------------------------------------------------

export interface DecomposeTimings {
  pollIntervalMs: number;
  decomposeTimeoutMs: number;
  planPersistTimeoutMs: number;
}

export const DEFAULT_DECOMPOSE_TIMINGS: DecomposeTimings = {
  pollIntervalMs: 1_000,
  // Aligned with the worker's 30-minute decomposer activity budget.
  // A large spec (>50KB) routinely takes 5-10 minutes; bumping the
  // CLI ceiling to 35 leaves slack for retries.
  decomposeTimeoutMs: 35 * 60_000,
  planPersistTimeoutMs: 5 * 60_000,
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface ReadModelDecomposition {
  id: string;
  status: "pending" | "running" | "ready" | "failed";
  manifest?: unknown;
  errorReason?: string;
}

async function postJson(
  url: string,
  body: unknown,
  deps: DecomposeDeps,
): Promise<unknown> {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} → ${res.status}: ${text}`);
  }
  return res.json().catch(() => ({}));
}

async function putJson(
  url: string,
  body: unknown,
  deps: DecomposeDeps,
): Promise<unknown> {
  const res = await deps.fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PUT ${url} → ${res.status}: ${text}`);
  }
  return res.json().catch(() => ({}));
}

async function getJson(
  url: string,
  deps: DecomposeDeps,
): Promise<unknown> {
  const res = await deps.fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Pure orchestration
// ---------------------------------------------------------------------------

export interface DecomposeAction {
  options: DecomposeOptions;
  deps: DecomposeDeps;
  timings?: DecomposeTimings;
}

export async function runDecomposeAction(
  action: DecomposeAction,
): Promise<number> {
  const { options, deps } = action;
  const timings = action.timings ?? DEFAULT_DECOMPOSE_TIMINGS;

  // 1. Probe API identity. If another service holds the port, fail
  //    fast with the structured `[pm-go] port <n> ...` message —
  //    same contract as `pm-go drive` / `pm-go status`.
  try {
    await probePmGoApi(deps.fetch, `${options.apiUrl}/health`);
  } catch (err) {
    if (err instanceof PmGoIdentityMismatchError) {
      deps.errLog(err.message);
      return 2;
    }
    deps.errLog(
      `pm-go decompose: API probe failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }

  // 2. Read the spec body off disk.
  let body: string;
  try {
    body = await deps.readFile(options.specPath);
  } catch (err) {
    deps.errLog(
      `pm-go decompose: cannot read spec at ${options.specPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }
  if (body.trim().length === 0) {
    deps.errLog(`pm-go decompose: spec at ${options.specPath} is empty`);
    return 2;
  }

  const title = options.title ?? deps.basename(options.specPath, ".md");

  // 3. Submit the spec + repo snapshot. The API both inserts the spec
  //    document and runs repo-intelligence on the supplied repoRoot.
  let intake: { specDocumentId: string; repoSnapshotId: string };
  try {
    const raw = await postJson(
      `${options.apiUrl}/spec-documents`,
      {
        title,
        body,
        repoRoot: options.repoRoot,
        source: "imported",
      },
      deps,
    );
    intake = raw as { specDocumentId: string; repoSnapshotId: string };
  } catch (err) {
    deps.errLog(
      `pm-go decompose: failed to submit spec: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }
  deps.log(
    `submitted spec ${intake.specDocumentId} (snapshot ${intake.repoSnapshotId})`,
  );

  // 4. Start the decomposition workflow.
  let decompositionId: string;
  try {
    const raw = await postJson(
      `${options.apiUrl}/spec-documents/${intake.specDocumentId}/decompose`,
      { repoSnapshotId: intake.repoSnapshotId },
      deps,
    );
    decompositionId = (raw as { decompositionId: string }).decompositionId;
  } catch (err) {
    deps.errLog(
      `pm-go decompose: failed to start decomposition: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }
  deps.log(`started decomposition ${decompositionId}; polling for manifest…`);

  // 5. Poll until the row reaches `ready` or `failed`.
  let final: ReadModelDecomposition | undefined;
  const outcome = await waitFor(
    async () => {
      const raw = await getJson(
        `${options.apiUrl}/spec-documents/${intake.specDocumentId}/decompositions/${decompositionId}`,
        deps,
      );
      const decomposition = (raw as { decomposition: ReadModelDecomposition })
        .decomposition;
      if (decomposition.status === "ready" || decomposition.status === "failed") {
        final = decomposition;
        return true;
      }
      return false;
    },
    {
      label: "decomposition manifest",
      timeoutMs: timings.decomposeTimeoutMs,
      intervalMs: timings.pollIntervalMs,
      onTick: (elapsedMs) =>
        deps.log(`…still waiting on decomposer (${Math.round(elapsedMs / 1000)}s)`),
    },
    { now: deps.now, sleep: deps.sleep },
  );

  if (outcome.status === "timeout") {
    deps.errLog(
      `pm-go decompose: timed out waiting for decomposition ${decompositionId}`,
    );
    return 2;
  }
  if (!final || final.status === "failed") {
    const reason = final?.errorReason ?? "(no error_reason)";
    deps.errLog(`pm-go decompose: decomposition failed: ${reason}`);
    return 1;
  }

  // 6. Print the manifest.
  let manifest = final.manifest as Record<string, unknown>;
  deps.log("");
  deps.log("manifest:");
  deps.log(JSON.stringify(manifest, null, 2));

  // 7. Optional edit pass — write tempfile, open editor, re-read, PUT.
  if (options.edit) {
    const tempPath = await deps.makeTempfile(`manifest-${decompositionId}.json`);
    await deps.writeFile(tempPath, JSON.stringify(manifest, null, 2));
    try {
      await deps.openEditor(tempPath);
    } catch (err) {
      deps.errLog(
        `pm-go decompose: editor exited with error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 2;
    }
    let edited: unknown;
    try {
      const editedText = await deps.readFile(tempPath);
      edited = JSON.parse(editedText);
    } catch (err) {
      deps.errLog(
        `pm-go decompose: edited manifest is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 2;
    }
    try {
      const raw = await putJson(
        `${options.apiUrl}/spec-documents/${intake.specDocumentId}/decompositions/${decompositionId}/manifest`,
        { manifest: edited },
        deps,
      );
      manifest = (raw as { decomposition: { manifest: Record<string, unknown> } })
        .decomposition.manifest;
      deps.log("saved edited manifest");
    } catch (err) {
      deps.errLog(
        `pm-go decompose: failed to save edited manifest: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 2;
    }
  }

  if (options.manifestOnly) {
    deps.log("--manifest-only: stopping before plan-first");
    return 0;
  }

  // 8. Submit the first milestone as a normal pm-go plan.
  let firstPlan: { planId: string; milestoneId: string };
  try {
    const raw = await postJson(
      `${options.apiUrl}/spec-documents/${intake.specDocumentId}/decompositions/${decompositionId}/plan-first`,
      {},
      deps,
    );
    firstPlan = raw as { planId: string; milestoneId: string };
  } catch (err) {
    deps.errLog(
      `pm-go decompose: failed to start first milestone plan: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }
  deps.log(
    `started plan ${firstPlan.planId} for milestone ${firstPlan.milestoneId}; polling for plan persistence…`,
  );

  // 9. Poll GET /plans/:id until the row is reachable. Mirrors
  //    `pm-go drive`'s persistence-wait shape but drives only until
  //    the plan is fetchable — driving it to release is out of scope
  //    for the decompose command.
  const planOutcome = await waitFor(
    async () => {
      const res = await deps.fetch(
        `${options.apiUrl}/plans/${firstPlan.planId}`,
      );
      return res.ok;
    },
    {
      label: `plan ${firstPlan.planId} persistence`,
      timeoutMs: timings.planPersistTimeoutMs,
      intervalMs: timings.pollIntervalMs,
    },
    { now: deps.now, sleep: deps.sleep },
  );
  if (planOutcome.status === "timeout") {
    deps.errLog(
      `pm-go decompose: timed out waiting for plan ${firstPlan.planId} to persist`,
    );
    return 2;
  }

  deps.log(`plan ${firstPlan.planId} ready; run \`pm-go drive --plan ${firstPlan.planId}\` to drive it.`);
  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry — argv-only wrapper that builds production deps + dispatches.
// ---------------------------------------------------------------------------

export async function decomposeCli(deps: DecomposeCliDeps): Promise<number> {
  const ctx: ParseDecomposeContext = {};
  if (deps.cwd !== undefined) ctx.cwd = deps.cwd;
  if (deps.resolve !== undefined) ctx.resolve = deps.resolve;
  const parsed = parseDecomposeArgv(deps.argv, ctx);
  if (!parsed.ok) {
    if (parsed.error === "help") {
      deps.log(DECOMPOSE_USAGE);
      return 0;
    }
    deps.errLog(`pm-go decompose: ${parsed.error}`);
    deps.errLog("");
    deps.errLog(DECOMPOSE_USAGE);
    return 2;
  }
  const action: DecomposeAction = {
    options: parsed.options,
    deps: deps.buildDecomposeDeps(),
  };
  return runDecomposeAction(action);
}
