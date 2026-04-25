import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseImplementArgv,
  IMPLEMENT_USAGE,
  implementCli,
  type ImplementCliDeps,
} from '../implement.js'

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

const cwd = '/abs/cwd'
const resolve = (a: string, b: string) => (b.startsWith('/') ? b : `${a}/${b}`)

describe('parseImplementArgv', () => {
  it('rejects when --spec is missing', () => {
    const r = parseImplementArgv(['--repo', '.'], cwd, resolve)
    assert.ok(!r.ok)
    assert.match(r.error, /--spec/)
  })

  it('parses --repo + --spec into absolute paths', () => {
    const r = parseImplementArgv(
      ['--repo', '.', '--spec', './feature.md'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.repoRoot, '/abs/cwd/.')
    assert.strictEqual(r.options.specPath, '/abs/cwd/./feature.md')
  })

  it('defaults --runtime to auto and --approve to all', () => {
    const r = parseImplementArgv(['--spec', '/abs/x.md'], cwd, resolve)
    assert.ok(r.ok)
    assert.strictEqual(r.options.runtime, 'auto')
    assert.strictEqual(r.options.approve, 'all')
  })

  it('accepts every approval mode', () => {
    for (const mode of ['all', 'none', 'interactive']) {
      const r = parseImplementArgv(
        ['--spec', '/abs/x.md', '--approve', mode],
        cwd,
        resolve,
      )
      assert.ok(r.ok, `approve=${mode} should parse`)
      assert.strictEqual(r.options.approve, mode)
    }
  })

  it('rejects an unknown --approve value', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--approve', 'magic'],
      cwd,
      resolve,
    )
    assert.ok(!r.ok)
    assert.match(r.error, /one of/)
  })

  it('passes through skipDocker + skipMigrate', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--skip-docker', '--skip-migrate'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.skipDocker, true)
    assert.strictEqual(r.options.skipMigrate, true)
  })

  it('rejects unknown flags', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--bogus'],
      cwd,
      resolve,
    )
    assert.ok(!r.ok)
    assert.match(r.error, /unknown flag/)
  })

  it('returns help signal on --help / -h', () => {
    for (const flag of ['--help', '-h']) {
      const r = parseImplementArgv([flag], cwd, resolve)
      assert.ok(!r.ok)
      assert.strictEqual(r.error, 'help')
    }
  })

  it('honors --port', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--port', '4000'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.apiPort, 4000)
  })

  it('rejects --port outside range', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--port', '99999'],
      cwd,
      resolve,
    )
    assert.ok(!r.ok)
  })
})

// ---------------------------------------------------------------------------
// implementCli — dispatch + early-exit paths
// ---------------------------------------------------------------------------

describe('implementCli', () => {
  function makeCliDeps(
    argv: string[],
    overrides: Partial<ImplementCliDeps> = {},
  ): { deps: ImplementCliDeps; logs: string[]; errs: string[] } {
    const logs: string[] = []
    const errs: string[] = []
    const deps: ImplementCliDeps = {
      argv,
      cwd: '/abs/cwd',
      monorepoRoot: '/abs/monorepo',
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      resolve,
      buildSupervisorDeps: () => {
        throw new Error('buildSupervisorDeps should not be called for early-exit paths')
      },
      buildDriveDeps: () => {
        throw new Error('buildDriveDeps should not be called for early-exit paths')
      },
      ...overrides,
    }
    return { deps, logs, errs }
  }

  it('--help prints the usage and exits 0', async () => {
    const { deps, logs } = makeCliDeps(['--help'])
    const code = await implementCli(deps)
    assert.strictEqual(code, 0)
    assert.ok(logs.join('\n').includes(IMPLEMENT_USAGE.split('\n')[0]!))
  })

  it('missing --spec exits 2 with usage', async () => {
    const { deps, errs } = makeCliDeps(['--repo', '.'])
    const code = await implementCli(deps)
    assert.strictEqual(code, 2)
    assert.ok(errs.some((l) => l.includes('--spec')))
  })

  it('unknown flag exits 2 with usage', async () => {
    const { deps, errs } = makeCliDeps(['--spec', '/abs/x.md', '--bogus'])
    const code = await implementCli(deps)
    assert.strictEqual(code, 2)
    assert.ok(errs.some((l) => l.includes('unknown flag')))
  })

  it('logs dotenv summary when applyDotenv loads a file', async () => {
    const { deps, logs } = makeCliDeps(['--help'], {
      applyDotenv: async () => ({
        loaded: true,
        applied: ['DATABASE_URL', 'API_PORT'],
        skipped: ['ANTHROPIC_API_KEY'],
        warnings: [],
      }),
    })
    await implementCli(deps)
    assert.ok(logs.some((l) => l.includes('loaded .env')))
    assert.ok(logs.some((l) => l.includes('2 applied')))
  })

  it('does NOT log dotenv summary when no .env loaded', async () => {
    const { deps, logs } = makeCliDeps(['--help'], {
      applyDotenv: async () => ({
        loaded: false,
        applied: [],
        skipped: [],
        warnings: [],
      }),
    })
    await implementCli(deps)
    assert.ok(!logs.some((l) => l.includes('loaded .env')))
  })
})
