/**
 * Pre-flight port-occupancy check for `pm-go run`.
 *
 * Before the supervisor binds Postgres / Temporal / API ports it
 * asks: is anyone already listening on these? If yes, who? If the
 * holder is one of OUR own processes (a pm-go supervisor or worker
 * the caller knows about), it's not a conflict — the caller is
 * presumably about to reattach. If the holder is anything else
 * (another pm-go we don't know about, a stray Postgres, the user's
 * desktop docker), it IS a conflict and we must surface it before
 * spawning duplicates.
 *
 * The platform-specific `lsof -nP -iTCP:<port> -sTCP:LISTEN` call
 * is injected via `PortPreflightDeps.probe` so this module stays
 * pure for tests. A production deps will shell out to lsof; the
 * tests here use an in-memory map of `port → {pid, command}`.
 *
 * No I/O, no top-level side effects — safe to import from contexts
 * that just want the types (e.g. `pm-go list`).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One observation from the platform port probe: a process holding
 * a TCP listen on `port`. The probe may return multiple holders if
 * IPv4 and IPv6 sockets coexist, hence the array shape returned by
 * `probe`.
 */
export interface PortHolder {
  pid: number
  /**
   * Short name of the process binary, e.g. "postgres", "node",
   * "temporal". Surfaced in conflict messages so users can find the
   * offender without manually running ps.
   */
  command?: string
}

/**
 * One conflict surfaced by `checkPorts`: a port we wanted to bind
 * was already held by a PID we don't recognise as ours.
 */
export interface PortConflict {
  port: number
  pid: number
  command?: string
}

export interface PortPreflightDeps {
  /**
   * Return every process listening on `port`. The empty array means
   * the port is free. Implementations should return an empty array
   * (not throw) when the platform probe finds no holders.
   *
   * In production this wraps `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn`;
   * in tests it's a fixture map.
   */
  probe: (port: number) => Promise<PortHolder[]>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Coerce the `knownPmGoPids` argument to a plain `Set<number>` so
 * callers can pass either a `Set` (which is the natural shape if
 * they're tracking children long-running) or an array (which is the
 * natural shape coming straight off a parsed `InstanceState.childPids`
 * record). Anything else is rejected at compile time.
 */
function asPidSet(input: ReadonlySet<number> | readonly number[]): Set<number> {
  if (input instanceof Set) return new Set(input)
  return new Set(input)
}

/**
 * Probe `ports` and return one `PortConflict` per (port, holder)
 * pair that is NOT in `knownPmGoPids`. Order of the returned array
 * is `(port asc, pid asc)` so output is stable across runs.
 *
 * The function probes ports sequentially rather than in parallel:
 * the platform `lsof` call is cheap, and serializing avoids the
 * "spawn 12 lsof processes at once" surprise on slower laptops.
 *
 * If `probe` rejects for a given port (e.g. `lsof` not installed),
 * we treat that port as a conflict-of-unknown-source by surfacing
 * a synthetic conflict with `pid: -1` and `command: 'probe failed: <msg>'`.
 * Burying the error would let `pm-go run` proceed and bind on top
 * of an existing process — strictly worse than a noisy message.
 */
export async function checkPorts(
  ports: readonly number[],
  knownPmGoPids: ReadonlySet<number> | readonly number[],
  deps: PortPreflightDeps,
): Promise<PortConflict[]> {
  const known = asPidSet(knownPmGoPids)
  const conflicts: PortConflict[] = []

  // Sort + dedupe ports so the caller can pass `[5432, 7233, 5432]`
  // without producing duplicate output rows.
  const uniquePorts = [...new Set(ports)].sort((a, b) => a - b)

  for (const port of uniquePorts) {
    let holders: PortHolder[]
    try {
      holders = await deps.probe(port)
    } catch (err) {
      conflicts.push({
        port,
        pid: -1,
        command: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    if (!Array.isArray(holders) || holders.length === 0) continue

    // Stable sort so two holders on the same port emit in pid-asc
    // order regardless of probe ordering.
    const sorted = [...holders].sort((a, b) => a.pid - b.pid)
    for (const h of sorted) {
      if (known.has(h.pid)) continue
      const conflict: PortConflict = { port, pid: h.pid }
      if (h.command !== undefined) conflict.command = h.command
      conflicts.push(conflict)
    }
  }

  return conflicts
}

/**
 * Convenience predicate for callers that just want a yes/no for a
 * single port without unpacking the conflict array.
 */
export async function isPortFree(
  port: number,
  knownPmGoPids: ReadonlySet<number> | readonly number[],
  deps: PortPreflightDeps,
): Promise<boolean> {
  const conflicts = await checkPorts([port], knownPmGoPids, deps)
  return conflicts.length === 0
}
