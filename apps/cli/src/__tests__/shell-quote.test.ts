import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { shellQuotePath, shellQuoteArgs } from '../lib/shell-quote.js'

// ---------------------------------------------------------------------------
// Pure-output assertions
// ---------------------------------------------------------------------------

describe('shellQuotePath (pure output)', () => {
  it('returns safe paths unchanged', () => {
    assert.strictEqual(shellQuotePath('/usr/local/bin/pm-go'), '/usr/local/bin/pm-go')
    assert.strictEqual(shellQuotePath('foo-bar_baz'), 'foo-bar_baz')
    assert.strictEqual(shellQuotePath('a:b/c.d=e@f%g+h,i'), 'a:b/c.d=e@f%g+h,i')
  })

  it('quotes a path containing whitespace', () => {
    assert.strictEqual(shellQuotePath('/tmp/with space/repo'), `'/tmp/with space/repo'`)
  })

  it('quotes a path containing a tab', () => {
    assert.strictEqual(shellQuotePath('a\tb'), `'a\tb'`)
  })

  it('quotes a path containing shell metacharacters', () => {
    assert.strictEqual(shellQuotePath('a$b'), `'a$b'`)
    assert.strictEqual(shellQuotePath('a;b'), `'a;b'`)
    assert.strictEqual(shellQuotePath('a|b'), `'a|b'`)
    assert.strictEqual(shellQuotePath('a`b`c'), `'a\`b\`c'`)
    assert.strictEqual(shellQuotePath('a*b'), `'a*b'`)
    assert.strictEqual(shellQuotePath('~/foo'), `'~/foo'`)
  })

  it('escapes embedded single quotes via the close-escape-reopen idiom', () => {
    // Path: a'b — should become 'a'\''b'
    assert.strictEqual(shellQuotePath(`a'b`), `'a'\\''b'`)
  })

  it('returns the literal `\'\'` for an empty string', () => {
    assert.strictEqual(shellQuotePath(''), `''`)
  })

  it('throws on non-string input', () => {
    assert.throws(
      () => shellQuotePath(null as unknown as string),
      /expected string/,
    )
  })
})

describe('shellQuoteArgs', () => {
  it('joins quoted args with single spaces', () => {
    assert.strictEqual(
      shellQuoteArgs(['/tmp/with space/repo', 'safe-arg']),
      `'/tmp/with space/repo' safe-arg`,
    )
  })
})

// ---------------------------------------------------------------------------
// Round-trip through bash to prove no word-splitting (ac-ae6f-3)
// ---------------------------------------------------------------------------

describe('shellQuotePath round-trip through bash', () => {
  it('a path with a space round-trips through bash without splitting', () => {
    const original = '/tmp/with space/repo'
    const quoted = shellQuotePath(original)

    // `printf '%s\n'` with one format spec emits one line per
    // remaining argument. If the shell word-split our quoted token
    // we'd see two lines (`/tmp/with` and `space/repo`). One line
    // means the shell saw exactly one argument.
    const result = spawnSync('bash', ['-c', `printf '%s\\n' ${quoted}`], {
      encoding: 'utf8',
    })
    assert.strictEqual(result.status, 0, `bash exited non-zero: ${result.stderr}`)
    const lines = result.stdout.split('\n').filter((l) => l.length > 0)
    assert.strictEqual(
      lines.length,
      1,
      `expected exactly one printf-emitted line, got: ${JSON.stringify(lines)}`,
    )
    assert.strictEqual(lines[0], original)
  })

  it('the same path passes `bash -n` syntax check (ac-ae6f-3 alt)', () => {
    const original = '/tmp/with space/repo'
    const quoted = shellQuotePath(original)
    // `bash -n` parses the script without executing it. If our
    // quoting produced a syntactically broken token (unbalanced
    // quote, etc) bash would exit non-zero with a parse error.
    const result = spawnSync('bash', ['-n', '-c', `: ${quoted}`], {
      encoding: 'utf8',
    })
    assert.strictEqual(
      result.status,
      0,
      `bash -n rejected the quoted token: ${result.stderr}`,
    )
  })

  it('a path with an embedded single quote round-trips through bash', () => {
    const original = `/tmp/it's/here`
    const quoted = shellQuotePath(original)
    const result = spawnSync('bash', ['-c', `printf '%s\\n' ${quoted}`], {
      encoding: 'utf8',
    })
    assert.strictEqual(result.status, 0, `bash exited non-zero: ${result.stderr}`)
    const lines = result.stdout.split('\n').filter((l) => l.length > 0)
    assert.strictEqual(lines.length, 1)
    assert.strictEqual(lines[0], original)
  })

  it('a path with shell metacharacters does not get expanded', () => {
    const original = '/tmp/$HOME/`whoami`/repo'
    const quoted = shellQuotePath(original)
    const result = spawnSync('bash', ['-c', `printf '%s\\n' ${quoted}`], {
      encoding: 'utf8',
    })
    assert.strictEqual(result.status, 0, `bash exited non-zero: ${result.stderr}`)
    const lines = result.stdout.split('\n').filter((l) => l.length > 0)
    assert.strictEqual(lines.length, 1)
    // Single-quoted, so $HOME and the backtick command stay literal.
    assert.strictEqual(lines[0], original)
  })
})
