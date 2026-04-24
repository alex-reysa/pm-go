import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runDoctor, resolveAutoRuntime, buildDoctorReport } from '../doctor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal DetectedRuntime stub (no @pm-go/runtime-detector import needed). */
function makeRuntime(cliCommand: string, version = '1.0.0') {
  return { adapter: { cliCommand }, version }
}

/** Capture runDoctor output into an array and return { lines, output, exitCode }. */
async function capture(
  opts: {
    env?: Record<string, string | undefined>
    runtimes?: ReturnType<typeof makeRuntime>[]
  } = {},
) {
  const lines: string[] = []
  const exitCode = await runDoctor({
    detectRuntimes: async () => opts.runtimes ?? [],
    env: opts.env ?? {},
    write: (l) => lines.push(l),
  })
  return { lines, output: lines.join('\n'), exitCode }
}

// ---------------------------------------------------------------------------
// ac-dc-03 — three --runtime auto resolution scenarios
// ---------------------------------------------------------------------------

describe('resolveAutoRuntime', () => {
  it('(a) SDK key set, no CLIs → anthropic-sdk', () => {
    const result = resolveAutoRuntime({ ANTHROPIC_API_KEY: 'sk-ant-test' }, [])
    assert.strictEqual(result.kind, 'anthropic-sdk')
    assert.ok(result.reason.includes('ANTHROPIC_API_KEY'))
  })

  it('(b) no SDK key, claude CLI on PATH → claude-cli', () => {
    const result = resolveAutoRuntime({}, [makeRuntime('claude', '1.2.3')])
    assert.strictEqual(result.kind, 'claude-cli')
    assert.ok(result.reason.includes('claude'))
  })

  it('(c) both ANTHROPIC_API_KEY and claude CLI available → anthropic-sdk wins', () => {
    const result = resolveAutoRuntime(
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
      [makeRuntime('claude', '1.2.3')],
    )
    assert.strictEqual(result.kind, 'anthropic-sdk')
  })
})

// ---------------------------------------------------------------------------
// ac-dc-02 — no runtime available → exits 1 + prints expected message
// ---------------------------------------------------------------------------

describe('runDoctor exit codes', () => {
  it('exits 1 when no API key and no CLI found', async () => {
    const { exitCode, output } = await capture({ env: {}, runtimes: [] })
    assert.strictEqual(exitCode, 1)
    assert.ok(output.includes('no supported runtime available'), `expected 'no supported runtime available' in: ${output}`)
  })

  it('exits 0 when ANTHROPIC_API_KEY is set', async () => {
    const { exitCode } = await capture({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      runtimes: [],
    })
    assert.strictEqual(exitCode, 0)
  })

  it('exits 0 when claude CLI is available', async () => {
    const { exitCode } = await capture({
      env: {},
      runtimes: [makeRuntime('claude')],
    })
    assert.strictEqual(exitCode, 0)
  })
})

// ---------------------------------------------------------------------------
// ac-dc-03 — assert printed resolution line matches expectations
// ---------------------------------------------------------------------------

describe('runDoctor resolution output line', () => {
  it('(a) SDK only: prints anthropic-sdk resolution', async () => {
    const { output } = await capture({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      runtimes: [],
    })
    assert.match(output, /--runtime auto\s+→\s+anthropic-sdk/)
    assert.ok(output.includes('ANTHROPIC_API_KEY is set'))
  })

  it('(b) CLI only: prints claude-cli resolution', async () => {
    const { output } = await capture({
      env: {},
      runtimes: [makeRuntime('claude', '1.2.3')],
    })
    assert.match(output, /--runtime auto\s+→\s+claude-cli/)
    assert.ok(output.includes('claude CLI found on PATH'))
  })

  it('(c) both: prints anthropic-sdk (API key takes priority)', async () => {
    const { output } = await capture({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      runtimes: [makeRuntime('claude', '1.2.3')],
    })
    assert.match(output, /--runtime auto\s+→\s+anthropic-sdk/)
    assert.ok(!output.includes('claude-cli'), 'should not mention claude-cli when SDK key wins')
  })
})

// ---------------------------------------------------------------------------
// ac-dc-04 — snapshot-style test for overall output structure / table format
// ---------------------------------------------------------------------------

const EXPECTED_ALL_RUNTIMES = `pm-go doctor
──────────────────────────────────────────

Environment
  ANTHROPIC_API_KEY        ✓ set
  OPENROUTER_API_KEY       ✓ set
  OPENAI_API_KEY           ✓ set

Local CLIs
  claude                   ✓ 1.2.3
  codex                    ✓ 0.1.0
  gemini                   ✓ 2.0.0

Runtime resolution
  --runtime auto           → anthropic-sdk  (ANTHROPIC_API_KEY is set)

Infrastructure
  (no additional checks in v0.8.0)`

const EXPECTED_NO_RUNTIMES = `pm-go doctor
──────────────────────────────────────────

Environment
  ANTHROPIC_API_KEY        not set
  OPENROUTER_API_KEY       not set
  OPENAI_API_KEY           not set

Local CLIs
  claude                   not found
  codex                    not found
  gemini                   not found

Runtime resolution
  --runtime auto           → no supported runtime available

Infrastructure
  (no additional checks in v0.8.0)`

describe('buildDoctorReport snapshot', () => {
  it('matches expected table structure with all runtimes present', () => {
    const runtimes = [
      makeRuntime('claude', '1.2.3'),
      makeRuntime('codex', '0.1.0'),
      makeRuntime('gemini', '2.0.0'),
    ]
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENROUTER_API_KEY: 'or-test',
      OPENAI_API_KEY: 'sk-test',
    }
    const report = buildDoctorReport(env, runtimes)
    assert.strictEqual(report, EXPECTED_ALL_RUNTIMES)
  })

  it('matches expected table structure with no runtimes', () => {
    const report = buildDoctorReport({}, [])
    assert.strictEqual(report, EXPECTED_NO_RUNTIMES)
  })

  it('contains all four required blocks', () => {
    const report = buildDoctorReport({}, [])
    assert.ok(report.includes('Environment'), 'missing Environment block')
    assert.ok(report.includes('Local CLIs'), 'missing Local CLIs block')
    assert.ok(report.includes('Runtime resolution'), 'missing Runtime resolution block')
    assert.ok(report.includes('Infrastructure'), 'missing Infrastructure block')
  })
})
