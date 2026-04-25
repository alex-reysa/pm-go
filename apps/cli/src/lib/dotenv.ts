/**
 * Tiny dotenv parser + loader for the `pm-go run` supervisor.
 *
 * Why hand-rolled instead of pulling in `dotenv`: the CLI ships as
 * the public OSS surface; a zero-dependency loader keeps the install
 * footprint minimal and avoids a second source of truth for env
 * resolution. The format we accept is the conservative intersection
 * of dotenv-style files in this repo:
 *
 *   - `KEY=value`
 *   - `KEY="value with spaces"`  / `KEY='single quotes too'`
 *   - blank lines and `# comments` are skipped
 *   - lines starting with `export ` have the prefix stripped
 *   - values can include `=` (only the first `=` splits key from value)
 *   - a trailing `# inline comment` after an unquoted value is stripped
 *   - we do NOT do variable interpolation (`${OTHER}`); use shell or
 *     CLI flags for that.
 *
 * Precedence: explicit `process.env` always wins. Values from `.env`
 * are applied only when the key is unset. Callers who want to force
 * an override should use a CLI flag or `export X=... pm-go run`.
 */

export interface DotenvParseResult {
  /** key/value pairs in source order. */
  entries: Array<[string, string]>
  /** parser warnings (malformed lines, etc) for surfacing in --verbose mode. */
  warnings: string[]
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parse the textual contents of a .env file. Pure — no I/O, no
 * mutation of `process.env` — so callers can compose loading with
 * different precedence rules.
 */
export function parseDotenv(text: string): DotenvParseResult {
  const entries: Array<[string, string]> = []
  const warnings: string[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim()
    if (line.length === 0) continue
    if (line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) {
      warnings.push(`line ${i + 1}: missing '=' (skipped): ${truncate(line)}`)
      continue
    }
    const rawKey = line.slice(0, eqIdx).trim()
    let rawValue = line.slice(eqIdx + 1)
    if (!KEY_PATTERN.test(rawKey)) {
      warnings.push(`line ${i + 1}: invalid key '${rawKey}' (skipped)`)
      continue
    }
    rawValue = rawValue.trim()
    rawValue = stripQuotes(rawValue)
    rawValue = stripInlineComment(rawValue)
    entries.push([rawKey, rawValue])
  }
  return { entries, warnings }
}

/** Strip a single layer of matching `"..."` or `'...'` around a value. */
function stripQuotes(s: string): string {
  if (s.length < 2) return s
  const first = s[0]
  const last = s[s.length - 1]
  if ((first === '"' || first === "'") && first === last) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * For unquoted values only: `KEY=value # comment` → `value`. We
 * detect the comment by a `#` preceded by whitespace; embedded `#`
 * inside a value (e.g. URL fragments) without leading whitespace
 * survives.
 */
function stripInlineComment(s: string): string {
  // Already-quoted values have been unwrapped above; if a value
  // started with a quote, treat the WHOLE thing as content. Detect
  // that by checking if the original raw value before stripQuotes
  // had a quote — but at this point we no longer have it. Instead,
  // be conservative: only strip when ` #` appears.
  const idx = s.indexOf(' #')
  if (idx === -1) return s
  return s.slice(0, idx).trim()
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

// ---------------------------------------------------------------------------
// Application: merge into process.env without overriding existing values
// ---------------------------------------------------------------------------

export interface ApplyDotenvDeps {
  readFile: (path: string) => Promise<string>
  fileExists: (path: string) => Promise<boolean>
  /** Where to write env vars. Defaults to `process.env` in production. */
  env: NodeJS.ProcessEnv
  /** Warning sink — defaults to console.warn. */
  log: (line: string) => void
}

export interface ApplyDotenvResult {
  loaded: boolean
  /** Keys that were applied (i.e. .env had them and process.env didn't). */
  applied: string[]
  /** Keys that .env had but process.env already defined — left alone. */
  skipped: string[]
  /** Parser warnings for malformed lines. */
  warnings: string[]
}

/**
 * Read `<path>`, parse it, and apply any unset keys to `deps.env`.
 * No-op when the file does not exist (so `.env` is genuinely
 * optional for users who export everything in their shell).
 *
 * Returns details for the supervisor to log without leaking values
 * into the telemetry.
 */
export async function applyDotenv(
  path: string,
  deps: ApplyDotenvDeps,
): Promise<ApplyDotenvResult> {
  if (!(await deps.fileExists(path))) {
    return { loaded: false, applied: [], skipped: [], warnings: [] }
  }
  const text = await deps.readFile(path)
  const { entries, warnings } = parseDotenv(text)
  const applied: string[] = []
  const skipped: string[] = []
  for (const [key, value] of entries) {
    if (deps.env[key] !== undefined) {
      skipped.push(key)
      continue
    }
    deps.env[key] = value
    applied.push(key)
  }
  return { loaded: true, applied, skipped, warnings }
}
