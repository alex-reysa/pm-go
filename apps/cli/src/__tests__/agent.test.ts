import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  agentCli,
  AGENT_USAGE,
  parseAgentArgv,
  type AgentCliDeps,
  type AgentOptions,
} from '../agent.js'

const cwd = '/abs/cwd'
const resolve = (base: string, p: string) =>
  p.startsWith('/') ? p : `${base}/${p}`

describe('parseAgentArgv', () => {
  it('parses root agent options', () => {
    const parsed = parseAgentArgv(
      [
        '--repo',
        '.',
        '--spec',
        './feature.md',
        '--title',
        'Feature',
        '--runtime',
        'stub',
        '--approve',
        'none',
        '--port',
        '4100',
      ],
      cwd,
      resolve,
    )

    assert.ok(parsed.ok)
    assert.deepStrictEqual(parsed.options, {
      repoRoot: '/abs/cwd/.',
      specPath: '/abs/cwd/./feature.md',
      title: 'Feature',
      runtime: 'stub',
      approve: 'none',
      yes: false,
      apiPort: 4100,
    })
  })

  it('allows no spec for an interactive operator session', () => {
    const parsed = parseAgentArgv([], cwd, resolve)
    assert.ok(parsed.ok)
    assert.deepStrictEqual(parsed.options, {
      repoRoot: '/abs/cwd',
      runtime: 'auto',
      approve: 'interactive',
      yes: false,
    })
  })

  it('--api-url wins over --port', () => {
    const parsed = parseAgentArgv(
      ['--port', '4100', '--api-url', 'http://127.0.0.1:9999'],
      cwd,
      resolve,
    )
    assert.ok(parsed.ok)
    assert.strictEqual(parsed.options.apiUrl, 'http://127.0.0.1:9999')
    assert.strictEqual(parsed.options.apiPort, undefined)
  })

  it('parses --resume', () => {
    const parsed = parseAgentArgv(['--resume', 'session-123'], cwd, resolve)
    assert.ok(parsed.ok)
    assert.strictEqual(parsed.options.resume, 'session-123')
  })

  it('--yes records yes and defaults approvals to all', () => {
    const parsed = parseAgentArgv(['--yes'], cwd, resolve)
    assert.ok(parsed.ok)
    assert.strictEqual(parsed.options.yes, true)
    assert.strictEqual(parsed.options.approve, 'all')
  })

  it('preserves explicit approval mode when --yes is also present', () => {
    const parsed = parseAgentArgv(
      ['--yes', '--approve', 'interactive'],
      cwd,
      resolve,
    )
    assert.ok(parsed.ok)
    assert.strictEqual(parsed.options.yes, true)
    assert.strictEqual(parsed.options.approve, 'interactive')
  })

  it('rejects unknown flags', () => {
    const parsed = parseAgentArgv(['--bogus'], cwd, resolve)
    assert.ok(!parsed.ok)
    assert.match(parsed.error, /unknown flag/)
  })

  it('returns help signal on --help / -h', () => {
    for (const flag of ['--help', '-h']) {
      const parsed = parseAgentArgv([flag], cwd, resolve)
      assert.ok(!parsed.ok)
      assert.strictEqual(parsed.error, 'help')
    }
  })
})

describe('agentCli', () => {
  function makeDeps(
    argv: string[],
    runOperatorAgent: AgentCliDeps['runOperatorAgent'],
  ): { deps: AgentCliDeps; logs: string[]; errs: string[] } {
    const logs: string[] = []
    const errs: string[] = []
    return {
      logs,
      errs,
      deps: {
        argv,
        cwd,
        log: (line) => logs.push(line),
        errLog: (line) => errs.push(line),
        resolve,
        ...(runOperatorAgent ? { runOperatorAgent } : {}),
      },
    }
  }

  it('calls the injected operator runner with parsed options', async () => {
    let seen: AgentOptions | undefined
    const { deps } = makeDeps(['--spec', './feature.md'], async (options) => {
      seen = options
      return 7
    })

    const code = await agentCli(deps)

    assert.strictEqual(code, 7)
    assert.deepStrictEqual(seen, {
      repoRoot: '/abs/cwd',
      specPath: '/abs/cwd/./feature.md',
      runtime: 'auto',
      approve: 'interactive',
      yes: false,
    })
  })

  it('prints friendly usage on parse errors', async () => {
    const { deps, errs } = makeDeps(['--runtime', 'bad'], async () => 0)
    const code = await agentCli(deps)

    assert.strictEqual(code, 2)
    assert.match(errs.join('\n'), /pm-go agent: --runtime/)
    assert.ok(errs.join('\n').includes(AGENT_USAGE.split('\n')[0]!))
  })

  it('--help prints usage and does not call the runner', async () => {
    let called = false
    const { deps, logs } = makeDeps(['--help'], async () => {
      called = true
      return 0
    })

    const code = await agentCli(deps)

    assert.strictEqual(code, 0)
    assert.strictEqual(called, false)
    assert.ok(logs.join('\n').includes(AGENT_USAGE.split('\n')[0]!))
  })
})
