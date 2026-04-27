/**
 * Shell-safe path quoting for command-line construction.
 *
 * When `pm-go` builds commands to hand off to a subshell — most
 * obviously when it prints a "you can re-run with: …" hint, or when
 * it composes a `bash -c '<cmd>'` line for a child process — paths
 * containing whitespace or shell metacharacters must be quoted or
 * the shell will word-split them. The classic gotcha is a repo
 * cloned to `/Users/me/Code Projects/foo`: an unquoted argument
 * splits into two and the downstream tool reads it as two paths.
 *
 * `shellQuotePath` returns a single shell token: the original path
 * if it's safe to leave bare, or a single-quoted form (with embedded
 * `'` escaped via the standard `'\''` trick) otherwise. Single-quote
 * form is preferred over double-quote because single quotes
 * suppress every form of expansion (`$VAR`, backticks, history
 * substitution, etc), so the output is robust against any path
 * content.
 *
 * Pure: no I/O, no module-level side effects.
 */

/**
 * Characters that, if present in a path, force quoting. Anything
 * outside this set in the "safe" character class is treated as
 * potentially shell-significant and triggers single-quote wrapping.
 *
 * The whitelist is conservative — alphanumerics plus the small set
 * of punctuation that POSIX shells uniformly leave alone. If you're
 * tempted to add `~`, don't: leading `~` is tilde-expanded by the
 * shell to the user's home dir, which is almost never what callers
 * want when they pass a literal path.
 */
const SAFE_CHAR_PATTERN = /^[A-Za-z0-9_\-./:=@%+,]+$/

/**
 * Return `path` as a single safely-quoted shell token.
 *
 *   - Empty string → `''` (so the token survives word-splitting as
 *     a literal empty argument).
 *   - All-safe characters → returned unchanged.
 *   - Anything else → wrapped in single quotes. Embedded single
 *     quotes are escaped using the `'\''` idiom — close the
 *     literal, emit an escaped quote, reopen the literal — which is
 *     the only fully-portable form across bash/zsh/dash.
 *
 * Throws on non-string input rather than coercing, because a `null`
 * sneaking in would otherwise produce the literal string `'null'`
 * and silently break a downstream command.
 */
export function shellQuotePath(path: string): string {
  if (typeof path !== 'string') {
    throw new TypeError(`shellQuotePath: expected string, got ${typeof path}`)
  }

  if (path.length === 0) return "''"
  if (SAFE_CHAR_PATTERN.test(path)) return path

  // Single-quote wrap with the `'\''` close-escape-reopen idiom.
  // Doing the replace on a per-char basis would also work but the
  // global replace is a tighter expression of intent.
  const escaped = path.replace(/'/g, `'\\''`)
  return `'${escaped}'`
}

/**
 * Convenience: quote every path and join with single spaces. Useful
 * for assembling multi-arg commands like
 * `cmd ${shellQuoteArgs([repo, dest])}`.
 */
export function shellQuoteArgs(paths: readonly string[]): string {
  return paths.map(shellQuotePath).join(' ')
}
