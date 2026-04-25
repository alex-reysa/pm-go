import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRunArgv, deriveTitle, buildChildEnv } from '../run.js'

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

const cwd = '/abs/cwd'
const resolve = (a: string, b: string) => (b.startsWith('/') ? b : `${a}/${b}`)

describe('parseRunArgv', () => {
  it('defaults to cwd as repoRoot when --repo is omitted', () => {
    const r = parseRunArgv([], cwd, resolve)
    assert.ok(r.ok)
    assert.strictEqual(r.options.repoRoot, cwd)
    assert.strictEqual(r.options.runtime, 'auto')
    assert.strictEqual(r.options.apiPort, 3001)
    assert.strictEqual(r.options.specPath, undefined)
    assert.strictEqual(r.options.skipDocker, false)
  })

  it('resolves --repo + --spec relative to cwd', () => {
    const r = parseRunArgv(
      ['--repo', '.', '--spec', './examples/golden-path/spec.md'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.repoRoot, '/abs/cwd/.')
    assert.strictEqual(
      r.options.specPath,
      '/abs/cwd/./examples/golden-path/spec.md',
    )
  })

  it('passes through absolute paths unchanged', () => {
    const r = parseRunArgv(
      ['--repo', '/srv/proj', '--spec', '/srv/proj/feat.md'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.repoRoot, '/srv/proj')
    assert.strictEqual(r.options.specPath, '/srv/proj/feat.md')
  })

  it('rejects unknown flags', () => {
    const r = parseRunArgv(['--bogus'], cwd, resolve)
    assert.ok(!r.ok)
    assert.match(r.error, /unknown flag/)
  })

  it('rejects --runtime with an unsupported value', () => {
    const r = parseRunArgv(['--runtime', 'magic'], cwd, resolve)
    assert.ok(!r.ok)
    assert.match(r.error, /one of/)
  })

  it('accepts every valid runtime value', () => {
    for (const mode of ['auto', 'stub', 'sdk', 'claude']) {
      const r = parseRunArgv(['--runtime', mode], cwd, resolve)
      assert.ok(r.ok, `runtime=${mode} should parse`)
      assert.strictEqual(r.options.runtime, mode)
    }
  })

  it('rejects --port outside 1..65535', () => {
    for (const bad of ['0', '99999', '-1', 'abc']) {
      const r = parseRunArgv(['--port', bad], cwd, resolve)
      assert.ok(!r.ok, `port=${bad} should fail`)
    }
  })

  it('parses --skip-docker and --skip-migrate as booleans', () => {
    const r = parseRunArgv(['--skip-docker', '--skip-migrate'], cwd, resolve)
    assert.ok(r.ok)
    assert.strictEqual(r.options.skipDocker, true)
    assert.strictEqual(r.options.skipMigrate, true)
  })

  it('returns help signal on --help / -h', () => {
    for (const flag of ['--help', '-h']) {
      const r = parseRunArgv([flag], cwd, resolve)
      assert.ok(!r.ok)
      assert.strictEqual(r.error, 'help')
    }
  })

  it('reports a missing value for flags that need one', () => {
    const r = parseRunArgv(['--repo'], cwd, resolve)
    assert.ok(!r.ok)
    assert.match(r.error, /--repo/)
  })
})

// ---------------------------------------------------------------------------
// deriveTitle
// ---------------------------------------------------------------------------

describe('deriveTitle', () => {
  it('uses the first H1 from the body', () => {
    const t = deriveTitle('# Add phase detail endpoint\n\nContext...', '/x/y.md')
    assert.strictEqual(t, 'Add phase detail endpoint')
  })

  it('skips H2/H3 when no H1 exists, falling back to filename', () => {
    const t = deriveTitle('## Subhead\n\nbody', '/path/to/spec-file.md')
    assert.strictEqual(t, 'spec-file')
  })

  it('strips file extension from the fallback', () => {
    const t = deriveTitle('no headings here', '/x/feature.markdown')
    assert.strictEqual(t, 'feature')
  })

  it('handles multi-line with H1 not on the first line', () => {
    const t = deriveTitle(
      '<!-- some preamble -->\n\n# Real Title\n\nbody',
      '/x.md',
    )
    assert.strictEqual(t, 'Real Title')
  })

  it('trims the leading whitespace inside an H1', () => {
    const t = deriveTitle('#    Padded   \n', '/x.md')
    assert.strictEqual(t, 'Padded')
  })
})

// ---------------------------------------------------------------------------
// buildChildEnv
// ---------------------------------------------------------------------------

describe('buildChildEnv', () => {
  const baseOptions = {
    repoRoot: '/abs/repo',
    specPath: undefined,
    title: undefined,
    apiPort: 3099,
    databaseUrl: 'postgres://x:y@host/z',
    skipDocker: false,
    skipMigrate: false,
  }

  it('passes DATABASE_URL, API_PORT, and REPO_ROOT to the child', () => {
    const env = buildChildEnv({ ...baseOptions, runtime: 'stub' })
    assert.strictEqual(env.DATABASE_URL, 'postgres://x:y@host/z')
    assert.strictEqual(env.API_PORT, '3099')
    assert.strictEqual(env.REPO_ROOT, '/abs/repo')
  })

  it('does NOT set *_RUNTIME when --runtime stub', () => {
    const env = buildChildEnv({ ...baseOptions, runtime: 'stub' })
    assert.strictEqual(env.PLANNER_RUNTIME, undefined)
    assert.strictEqual(env.IMPLEMENTER_RUNTIME, undefined)
  })

  it('sets every *_RUNTIME for sdk/claude/auto', () => {
    for (const mode of ['sdk', 'claude', 'auto'] as const) {
      const env = buildChildEnv({ ...baseOptions, runtime: mode })
      assert.strictEqual(env.PLANNER_RUNTIME, mode)
      assert.strictEqual(env.IMPLEMENTER_RUNTIME, mode)
      assert.strictEqual(env.REVIEWER_RUNTIME, mode)
      assert.strictEqual(env.PHASE_AUDITOR_RUNTIME, mode)
      assert.strictEqual(env.COMPLETION_AUDITOR_RUNTIME, mode)
    }
  })
})
