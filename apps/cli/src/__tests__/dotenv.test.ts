import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseDotenv, applyDotenv } from '../lib/dotenv.js'

// ---------------------------------------------------------------------------
// parseDotenv — pure parser
// ---------------------------------------------------------------------------

describe('parseDotenv', () => {
  it('parses simple KEY=value pairs in source order', () => {
    const r = parseDotenv('A=1\nB=two\nC=three')
    assert.deepStrictEqual(r.entries, [
      ['A', '1'],
      ['B', 'two'],
      ['C', 'three'],
    ])
    assert.deepStrictEqual(r.warnings, [])
  })

  it('ignores blank lines and comments', () => {
    const r = parseDotenv('\n# this is a comment\nA=1\n\n# another\nB=2')
    assert.deepStrictEqual(r.entries, [
      ['A', '1'],
      ['B', '2'],
    ])
  })

  it('strips a leading `export ` prefix', () => {
    const r = parseDotenv('export DATABASE_URL=postgres://x:y@h/z')
    assert.deepStrictEqual(r.entries, [
      ['DATABASE_URL', 'postgres://x:y@h/z'],
    ])
  })

  it('handles quoted values with spaces', () => {
    const r = parseDotenv('TITLE="hello world"\nQUOTED=\'single\'')
    assert.deepStrictEqual(r.entries, [
      ['TITLE', 'hello world'],
      ['QUOTED', 'single'],
    ])
  })

  it('treats `=` in the value verbatim (only the first `=` splits)', () => {
    const r = parseDotenv('URL=https://x.com?a=1&b=2')
    assert.deepStrictEqual(r.entries, [
      ['URL', 'https://x.com?a=1&b=2'],
    ])
  })

  it('strips inline comments after an unquoted value', () => {
    const r = parseDotenv('A=raw # trailing comment')
    assert.deepStrictEqual(r.entries, [['A', 'raw']])
  })

  it('keeps a `#` inside an unquoted value when not preceded by whitespace', () => {
    const r = parseDotenv('FRAG=https://x.com/page#anchor')
    assert.deepStrictEqual(r.entries, [
      ['FRAG', 'https://x.com/page#anchor'],
    ])
  })

  it('warns and skips lines without `=`', () => {
    const r = parseDotenv('A=1\nthis is not a line\nB=2')
    assert.deepStrictEqual(r.entries, [
      ['A', '1'],
      ['B', '2'],
    ])
    assert.strictEqual(r.warnings.length, 1)
    assert.match(r.warnings[0]!, /missing '='/)
  })

  it('warns and skips lines with an invalid key', () => {
    const r = parseDotenv('A=1\n9NUMERIC=2\nB-DASH=3\nC=4')
    assert.deepStrictEqual(r.entries, [
      ['A', '1'],
      ['C', '4'],
    ])
    assert.strictEqual(r.warnings.length, 2)
  })

  it('handles CRLF line endings (Windows .env files)', () => {
    const r = parseDotenv('A=1\r\nB=2\r\nC=3')
    assert.deepStrictEqual(r.entries, [
      ['A', '1'],
      ['B', '2'],
      ['C', '3'],
    ])
  })
})

// ---------------------------------------------------------------------------
// applyDotenv — precedence + I/O wiring
// ---------------------------------------------------------------------------

describe('applyDotenv', () => {
  function makeDeps(opts: {
    file?: string
    env?: NodeJS.ProcessEnv
  } = {}) {
    const env: NodeJS.ProcessEnv = { ...(opts.env ?? {}) }
    const log: string[] = []
    return {
      env,
      log,
      deps: {
        env,
        log: (l: string) => log.push(l),
        readFile: async (_path: string) => opts.file ?? '',
        fileExists: async (_path: string) => opts.file !== undefined,
      },
    }
  }

  it('returns loaded=false when the file does not exist', async () => {
    const { deps } = makeDeps({})
    const r = await applyDotenv('/no/such/path', deps)
    assert.strictEqual(r.loaded, false)
    assert.deepStrictEqual(r.applied, [])
    assert.deepStrictEqual(r.skipped, [])
  })

  it('applies unset keys to env', async () => {
    const { env, deps } = makeDeps({ file: 'A=one\nB=two' })
    const r = await applyDotenv('/x', deps)
    assert.strictEqual(r.loaded, true)
    assert.deepStrictEqual(r.applied.sort(), ['A', 'B'])
    assert.strictEqual(env.A, 'one')
    assert.strictEqual(env.B, 'two')
  })

  it('does NOT override pre-set keys (shell exports win)', async () => {
    const { env, deps } = makeDeps({
      file: 'A=fromfile\nB=fromfile',
      env: { A: 'fromshell' },
    })
    const r = await applyDotenv('/x', deps)
    assert.deepStrictEqual(r.applied, ['B'])
    assert.deepStrictEqual(r.skipped, ['A'])
    assert.strictEqual(env.A, 'fromshell')
    assert.strictEqual(env.B, 'fromfile')
  })

  it('surfaces parser warnings without aborting application', async () => {
    const { env, deps } = makeDeps({
      file: 'GOOD=1\nbroken line\n9BAD=2\nALSO_GOOD=3',
    })
    const r = await applyDotenv('/x', deps)
    assert.strictEqual(r.loaded, true)
    assert.deepStrictEqual(r.applied.sort(), ['ALSO_GOOD', 'GOOD'])
    assert.ok(r.warnings.length >= 2, 'expected warnings for broken lines')
    assert.strictEqual(env.GOOD, '1')
    assert.strictEqual(env.ALSO_GOOD, '3')
  })
})
