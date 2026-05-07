export type AgentRuntime = 'auto' | 'stub' | 'sdk' | 'claude'
export type AgentApprovalMode = 'all' | 'none' | 'interactive'

export interface AgentOptions {
  repoRoot: string
  specPath?: string
  title?: string
  runtime: AgentRuntime
  approve: AgentApprovalMode
  yes: boolean
  resume?: string
  apiPort?: number
  apiUrl?: string
}

export interface AgentCliDeps {
  argv: readonly string[]
  cwd: string
  log: (line: string) => void
  errLog: (line: string) => void
  resolve: (base: string, path: string) => string
  runOperatorAgent?: RunOperatorAgent
}

export type RunOperatorAgent = (options: AgentOptions) => Promise<number>

export const AGENT_USAGE = `Usage: pm-go [agent] [options]

Start an agentic operator session. With --spec, the operator implements the
requested change; without --spec, it starts an interactive session.

Options:
  -r, --repo <path>              Repository root (default: current directory).
  -s, --spec <path>              Spec file to implement.
      --title <title>            Human-readable session title.
      --runtime <mode>           Runtime: auto, stub, sdk, claude (default auto).
      --approve <mode>           Approvals: all, none, interactive.
      --yes                      Accept default confirmations.
      --resume <session>         Resume an existing operator session.
  -p, --port <n>                 API port used to derive http://127.0.0.1:<n>.
      --api-url <url>            API URL. Wins over --port.
  -h, --help                     Show this message.`

type ParseAgentResult =
  | { ok: true; options: AgentOptions }
  | { ok: false; error: string }

const RUNTIMES = new Set<AgentRuntime>(['auto', 'stub', 'sdk', 'claude'])
const APPROVAL_MODES = new Set<AgentApprovalMode>([
  'all',
  'none',
  'interactive',
])

export function parseAgentArgv(
  argv: readonly string[],
  cwd: string,
  resolve: (base: string, path: string) => string,
): ParseAgentResult {
  let repoRoot = cwd
  let specPath: string | undefined
  let title: string | undefined
  let runtime: AgentRuntime = 'auto'
  let approve: AgentApprovalMode = 'interactive'
  let approveExplicit = false
  let yes = false
  let resume: string | undefined
  let apiPort: number | undefined
  let apiUrl: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') {
      return { ok: false, error: 'help' }
    }
    if (flag === '--yes') {
      yes = true
      if (!approveExplicit) approve = 'all'
      continue
    }

    const value = argv[i + 1]
    switch (flag) {
      case '--repo':
      case '-r':
        if (value === undefined) return { ok: false, error: `${flag} requires a value` }
        repoRoot = resolve(cwd, value)
        i++
        continue
      case '--spec':
      case '-s':
        if (value === undefined) return { ok: false, error: `${flag} requires a value` }
        specPath = resolve(cwd, value)
        i++
        continue
      case '--title':
        if (value === undefined) return { ok: false, error: '--title requires a value' }
        title = value
        i++
        continue
      case '--runtime':
        if (value === undefined) return { ok: false, error: '--runtime requires a value' }
        if (!RUNTIMES.has(value as AgentRuntime)) {
          return {
            ok: false,
            error: '--runtime must be one of: auto, stub, sdk, claude',
          }
        }
        runtime = value as AgentRuntime
        i++
        continue
      case '--approve':
        if (value === undefined) return { ok: false, error: '--approve requires a value' }
        if (!APPROVAL_MODES.has(value as AgentApprovalMode)) {
          return {
            ok: false,
            error: '--approve must be one of: all, none, interactive',
          }
        }
        approve = value as AgentApprovalMode
        approveExplicit = true
        i++
        continue
      case '--resume':
        if (value === undefined) return { ok: false, error: '--resume requires a value' }
        resume = value
        i++
        continue
      case '--port':
      case '-p': {
        if (value === undefined) return { ok: false, error: `${flag} requires a value` }
        const parsedPort = Number.parseInt(value, 10)
        if (
          !Number.isInteger(parsedPort) ||
          String(parsedPort) !== value ||
          parsedPort < 1 ||
          parsedPort > 65535
        ) {
          return { ok: false, error: '--port must be an integer between 1 and 65535' }
        }
        apiPort = parsedPort
        i++
        continue
      }
      case '--api-url':
        if (value === undefined) return { ok: false, error: '--api-url requires a value' }
        apiUrl = value
        i++
        continue
      default:
        return { ok: false, error: `unknown flag: ${flag ?? ''}` }
    }
  }

  return {
    ok: true,
    options: {
      repoRoot,
      ...(specPath ? { specPath } : {}),
      ...(title ? { title } : {}),
      runtime,
      approve,
      yes,
      ...(resume ? { resume } : {}),
      ...(apiUrl ? {} : apiPort !== undefined ? { apiPort } : {}),
      ...(apiUrl ? { apiUrl } : {}),
    },
  }
}

export async function agentCli(cliDeps: AgentCliDeps): Promise<number> {
  const parsed = parseAgentArgv(cliDeps.argv, cliDeps.cwd, cliDeps.resolve)
  if (!parsed.ok) {
    if (parsed.error === 'help') {
      cliDeps.log(AGENT_USAGE)
      return 0
    }
    cliDeps.errLog(`pm-go agent: ${parsed.error}`)
    cliDeps.errLog('')
    cliDeps.errLog(AGENT_USAGE)
    return 2
  }

  const runOperatorAgent =
    cliDeps.runOperatorAgent ??
    (await loadProductionOperatorAgent(cliDeps.errLog, cliDeps.log))
  if (!runOperatorAgent) {
    return 1
  }
  return runOperatorAgent(parsed.options)
}

async function loadProductionOperatorAgent(
  errLog: (line: string) => void,
  log: (line: string) => void,
): Promise<RunOperatorAgent | undefined> {
  try {
    const dynamicImport = new Function(
      'specifier',
      'return import(specifier)',
    ) as (specifier: string) => Promise<unknown>
    const mod = (await dynamicImport('@pm-go/orchestrator')) as {
      runOperatorAgent?: unknown
    }
    if (typeof mod.runOperatorAgent === 'function') {
      return async (options) => {
        const result = await (mod.runOperatorAgent as (o: AgentOptions) => Promise<unknown>)(options)
        if (typeof result === 'number') return result
        if (result && typeof result === 'object') {
          const status = (result as { status?: unknown }).status
          const text = (result as { text?: unknown }).text
          if (typeof text === 'string' && text.trim().length > 0) {
            log(text)
          }
          return status === 'completed' ? 0 : 1
        }
        return 0
      }
    }
    errLog('pm-go agent: @pm-go/orchestrator does not export runOperatorAgent')
    return undefined
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errLog(`pm-go agent: unable to load @pm-go/orchestrator (${message})`)
    return undefined
  }
}
