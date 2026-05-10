import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatStaleOrchestratorRunRecovery,
  loadDotenvForAgent,
  recoverStaleOrchestratorRuns,
  resolveCliDispatch,
} from '../index.js'

describe('resolveCliDispatch', () => {
  it('routes root options to agent mode', () => {
    assert.deepStrictEqual(resolveCliDispatch(['--spec', './feature.md']), {
      kind: 'agent',
      argv: ['--spec', './feature.md'],
    })
  })

  it('routes no args to agent mode for an interactive operator session', () => {
    assert.deepStrictEqual(resolveCliDispatch([]), {
      kind: 'agent',
      argv: [],
    })
  })

  it('routes pm-go agent as an explicit agent alias', () => {
    assert.deepStrictEqual(
      resolveCliDispatch(['agent', '--resume', 'session-123']),
      {
        kind: 'agent',
        argv: ['--resume', 'session-123'],
      },
    )
  })

  it('routes implement to agent mode by default', () => {
    const dispatch = resolveCliDispatch(['implement', '--spec', './feature.md'])

    assert.strictEqual(dispatch.kind, 'agent')
    assert.deepStrictEqual(
      dispatch.kind === 'agent' ? dispatch.argv : undefined,
      ['--spec', './feature.md'],
    )
    assert.match(
      dispatch.kind === 'agent' ? dispatch.compatibilityLog ?? '' : '',
      /--legacy-drive/,
    )
  })

  it('routes implement --legacy-drive to legacy implement and strips the flag', () => {
    assert.deepStrictEqual(
      resolveCliDispatch([
        'implement',
        '--repo',
        '.',
        '--legacy-drive',
        '--spec',
        './feature.md',
      ]),
      {
        kind: 'legacy',
        subcommand: 'implement',
        argv: ['--repo', '.', '--spec', './feature.md'],
      },
    )
  })

  // Claim 5 — `pm-go implement --help` must reach the legacy `implement`
  // help text, not the agentic operator. Without the help-aware bypass
  // the operator agent would swallow `--help` as just another root flag
  // and never print the legacy usage block.
  it('routes implement --help to legacy implement', () => {
    assert.deepStrictEqual(
      resolveCliDispatch(['implement', '--help']),
      {
        kind: 'legacy',
        subcommand: 'implement',
        argv: ['--help'],
      },
    )
  })

  it('routes implement -h to legacy implement', () => {
    assert.deepStrictEqual(
      resolveCliDispatch(['implement', '-h']),
      {
        kind: 'legacy',
        subcommand: 'implement',
        argv: ['-h'],
      },
    )
  })

  // Precedence — when both --legacy-drive and --help are present, the
  // explicit --legacy-drive route wins (operator typed it for a reason)
  // but the flag itself is still stripped before forwarding to the
  // legacy implement parser.
  it('routes implement --legacy-drive --help to legacy implement and strips --legacy-drive', () => {
    assert.deepStrictEqual(
      resolveCliDispatch(['implement', '--legacy-drive', '--help']),
      {
        kind: 'legacy',
        subcommand: 'implement',
        argv: ['--help'],
      },
    )
  })

  // Sanity guards on the implement-to-agent default route.
  it('routes bare pm-go implement to agent mode', () => {
    const dispatch = resolveCliDispatch(['implement'])
    assert.strictEqual(dispatch.kind, 'agent')
    assert.deepStrictEqual(
      dispatch.kind === 'agent' ? dispatch.argv : undefined,
      [],
    )
  })

  it('routes pm-go implement --some-flag (non-help) to agent mode', () => {
    const dispatch = resolveCliDispatch(['implement', '--some-flag'])
    assert.strictEqual(dispatch.kind, 'agent')
    assert.deepStrictEqual(
      dispatch.kind === 'agent' ? dispatch.argv : undefined,
      ['--some-flag'],
    )
  })

  it('keeps known legacy subcommands on the legacy path', () => {
    assert.deepStrictEqual(resolveCliDispatch(['run', '--spec', './feature.md']), {
      kind: 'legacy',
      subcommand: 'run',
      argv: ['--spec', './feature.md'],
    })
  })

  it('preserves root help usage dispatch', () => {
    assert.deepStrictEqual(resolveCliDispatch(['--help']), {
      kind: 'root-help',
    })
  })
})

describe('loadDotenvForAgent', () => {
  // Regression: the agent dispatch path used to skip .env entirely,
  // so env vars like PLANNER_BUDGET_USD never reached the worker the
  // agent spawned. The fix routes dotenv through loadDotenvForAgent
  // before agentCli runs; these tests pin that wiring.
  it('invokes applyDotenv with <monorepoRoot>/.env and applies missing keys', async () => {
    let seenPath = ''
    let seenEnvPassed: NodeJS.ProcessEnv | undefined
    const env: NodeJS.ProcessEnv = { ALREADY_SET: 'shell' }
    const logs: string[] = []
    const errs: string[] = []
    const result = await loadDotenvForAgent('/abs/repo', {
      applyDotenv: async (p, d) => {
        seenPath = p
        seenEnvPassed = d.env
        // Simulate dotenv setting an unset key and skipping the one
        // already exported in the shell.
        d.env['PLANNER_BUDGET_USD'] = '2.5'
        return {
          loaded: true,
          applied: ['PLANNER_BUDGET_USD'],
          skipped: ['ALREADY_SET'],
          warnings: [],
        }
      },
      readFile: async () => '',
      fileExists: async () => true,
      env,
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
    })

    assert.strictEqual(seenPath, '/abs/repo/.env')
    assert.strictEqual(seenEnvPassed, env)
    assert.strictEqual(env['PLANNER_BUDGET_USD'], '2.5')
    assert.deepStrictEqual(result, {
      loaded: true,
      applied: ['PLANNER_BUDGET_USD'],
      skipped: ['ALREADY_SET'],
      warnings: [],
    })
    assert.ok(
      logs.some((l) =>
        l.startsWith('[pm-go] loaded .env (1 applied, 1 pre-set in shell)'),
      ),
      `expected banner in logs: ${JSON.stringify(logs)}`,
    )
    assert.deepStrictEqual(errs, [])
  })

  it('is a silent no-op when .env is absent', async () => {
    const logs: string[] = []
    const errs: string[] = []
    const result = await loadDotenvForAgent('/abs/repo', {
      applyDotenv: async () => ({
        loaded: false,
        applied: [],
        skipped: [],
        warnings: [],
      }),
      readFile: async () => '',
      fileExists: async () => false,
      env: {},
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
    })

    assert.strictEqual(result.loaded, false)
    assert.deepStrictEqual(logs, [])
    assert.deepStrictEqual(errs, [])
  })

  it('forwards parser warnings to errLog', async () => {
    const logs: string[] = []
    const errs: string[] = []
    await loadDotenvForAgent('/abs/repo', {
      applyDotenv: async () => ({
        loaded: true,
        applied: [],
        skipped: [],
        warnings: ['line 3: missing = (skipped): BOGUS'],
      }),
      readFile: async () => '',
      fileExists: async () => true,
      env: {},
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
    })

    assert.ok(
      errs.some((l) => l.includes('[pm-go] .env: line 3: missing =')),
      `expected warning in errs: ${JSON.stringify(errs)}`,
    )
  })
})

describe('recoverStaleOrchestratorRuns', () => {
  it('marks only running planless orchestrator rows failed', async () => {
    let seenSql = ''
    const result = await recoverStaleOrchestratorRuns({
      monorepoRoot: '/abs/monorepo',
      exec: async (_cmd, args) => {
        seenSql = String(args.at(-1))
        return { code: 0, stdout: '2\n', stderr: '' }
      },
    })

    assert.deepStrictEqual(result, { status: 'updated', count: 2 })
    assert.match(seenSql, /UPDATE agent_runs/)
    assert.match(seenSql, /role = 'orchestrator'/)
    assert.match(seenSql, /plan_id IS NULL/)
    assert.match(seenSql, /status = 'running'/)
  })

  it('formats skipped postgres cleanup without throwing', () => {
    assert.strictEqual(
      formatStaleOrchestratorRunRecovery({
        status: 'skipped',
        reason: 'postgres unavailable',
      }),
      '(agent_runs cleanup skipped: postgres unavailable)',
    )
  })
})
