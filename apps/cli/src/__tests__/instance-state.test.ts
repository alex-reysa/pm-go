import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  STATE_DIR_MODE,
  instanceStateDir,
  instanceStatePath,
  parseStateFilename,
  readInstanceState,
  writeInstanceState,
  removeInstanceState,
  listInstanceStates,
  validateInstanceState,
  type InstanceState,
  type InstanceStateDeps,
} from '../lib/instance-state.js'

// ---------------------------------------------------------------------------
// Test helpers — fake filesystem with mkdir-mode tracking
// ---------------------------------------------------------------------------

interface FakeFs {
  files: Map<string, string>
  dirs: Set<string>
  /** Last mode passed to mkdir for each directory. */
  dirModes: Map<string, number | undefined>
  /** Sequence of filesystem ops in call order — useful for atomicity asserts. */
  ops: Array<
    | { kind: 'writeFile'; path: string }
    | { kind: 'rename'; from: string; to: string }
    | { kind: 'mkdir'; path: string; mode: number | undefined }
    | { kind: 'unlink'; path: string }
  >
}

function makeFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial))
  const dirs = new Set<string>()
  const dirModes = new Map<string, number | undefined>()
  for (const path of files.keys()) addParents(path, dirs)
  return { files, dirs, dirModes, ops: [] }
}

function addParents(path: string, dirs: Set<string>): void {
  const parts = path.split('/').filter(Boolean)
  let current = ''
  for (let i = 0; i < parts.length - 1; i++) {
    current += `/${parts[i]}`
    dirs.add(current)
  }
}

function makeDeps(fs: FakeFs): InstanceStateDeps {
  return {
    readFile: async (path) => {
      const v = fs.files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    writeFile: async (path, content) => {
      addParents(path, fs.dirs)
      fs.files.set(path, content)
      fs.ops.push({ kind: 'writeFile', path })
    },
    mkdir: async (path, opts) => {
      const parts = path.split('/').filter(Boolean)
      let current = ''
      for (const p of parts) {
        current += `/${p}`
        fs.dirs.add(current)
      }
      // Only the leaf dir gets the requested mode; node's recursive
      // mkdir behaves the same way.
      fs.dirModes.set(path, opts.mode)
      fs.ops.push({ kind: 'mkdir', path, mode: opts.mode })
    },
    fileExists: async (path) => fs.files.has(path) || fs.dirs.has(path),
    rename: async (from, to) => {
      const v = fs.files.get(from)
      if (v === undefined) throw new Error(`ENOENT: ${from}`)
      fs.files.delete(from)
      fs.files.set(to, v)
      addParents(to, fs.dirs)
      fs.ops.push({ kind: 'rename', from, to })
    },
    unlink: async (path) => {
      if (!fs.files.has(path)) throw new Error(`ENOENT: ${path}`)
      fs.files.delete(path)
      fs.ops.push({ kind: 'unlink', path })
    },
    readdir: async (path) => {
      const out = new Set<string>()
      const prefix = path.endsWith('/') ? path : `${path}/`
      for (const f of fs.files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length)
          const head = rest.split('/')[0]
          if (head) out.add(head)
        }
      }
      return [...out]
    },
  }
}

const HOME = '/home/user'

function fullValidState(overrides: Partial<InstanceState> = {}): InstanceState {
  return {
    instanceName: 'default',
    apiPort: 3001,
    pid: 12345,
    startedAt: '2026-04-25T12:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('instanceStateDir', () => {
  it('builds <homeDir>/.pm-go/state', () => {
    assert.strictEqual(instanceStateDir('/home/u'), '/home/u/.pm-go/state')
  })

  it('strips a trailing slash from homeDir', () => {
    assert.strictEqual(instanceStateDir('/home/u/'), '/home/u/.pm-go/state')
  })

  it('rejects empty homeDir', () => {
    assert.throws(() => instanceStateDir(''), /homeDir/)
  })
})

describe('instanceStatePath', () => {
  it('builds <homeDir>/.pm-go/state/<apiPort>.json', () => {
    assert.strictEqual(
      instanceStatePath(3001, '/home/u'),
      '/home/u/.pm-go/state/3001.json',
    )
  })

  it('rejects an out-of-range apiPort', () => {
    assert.throws(() => instanceStatePath(0, HOME), /apiPort/)
    assert.throws(() => instanceStatePath(99999, HOME), /apiPort/)
    assert.throws(() => instanceStatePath(-1, HOME), /apiPort/)
  })

  it('rejects a non-integer apiPort', () => {
    assert.throws(() => instanceStatePath(3001.5, HOME), /apiPort/)
  })
})

describe('parseStateFilename', () => {
  it('returns the port for <port>.json', () => {
    assert.strictEqual(parseStateFilename('3001.json'), 3001)
    assert.strictEqual(parseStateFilename('65535.json'), 65535)
    assert.strictEqual(parseStateFilename('1.json'), 1)
  })

  it('returns null for non-matching names', () => {
    assert.strictEqual(parseStateFilename('.DS_Store'), null)
    assert.strictEqual(parseStateFilename('3001.json.tmp'), null)
    assert.strictEqual(parseStateFilename('abc.json'), null)
    assert.strictEqual(parseStateFilename('3001'), null)
    // No leading-zero / signed / decimal forms.
    assert.strictEqual(parseStateFilename('03001.json'), null)
    assert.strictEqual(parseStateFilename('-1.json'), null)
    assert.strictEqual(parseStateFilename('3001.5.json'), null)
  })

  it('returns null for out-of-range numbers', () => {
    assert.strictEqual(parseStateFilename('0.json'), null)
    assert.strictEqual(parseStateFilename('99999.json'), null)
  })
})

// ---------------------------------------------------------------------------
// validateInstanceState
// ---------------------------------------------------------------------------

describe('validateInstanceState', () => {
  it('accepts a full valid state', () => {
    const r = validateInstanceState(fullValidState())
    assert.ok(r.ok)
    assert.strictEqual(r.state.instanceName, 'default')
  })

  it('accepts childPids when present', () => {
    const r = validateInstanceState(fullValidState({ childPids: [12346, 12347] }))
    assert.ok(r.ok)
    assert.deepStrictEqual(r.state.childPids, [12346, 12347])
  })

  it('rejects non-object input with a single error', () => {
    const r = validateInstanceState('not an object')
    assert.ok(!r.ok)
    assert.strictEqual(r.errors.length, 1)
  })

  it('rejects a missing required field', () => {
    const s = fullValidState() as unknown as Record<string, unknown>
    delete s.instanceName
    const r = validateInstanceState(s)
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /instanceName/.test(e)))
  })

  it('rejects an out-of-range apiPort', () => {
    const r = validateInstanceState(fullValidState({ apiPort: 99999 }))
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /apiPort/.test(e)))
  })

  it('rejects a non-positive pid', () => {
    const r = validateInstanceState(fullValidState({ pid: 0 }))
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /pid/.test(e)))
  })

  it('rejects a non-array childPids', () => {
    const s = fullValidState() as unknown as Record<string, unknown>
    s.childPids = 'not an array'
    const r = validateInstanceState(s)
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /childPids/.test(e)))
  })
})

// ---------------------------------------------------------------------------
// readInstanceState
// ---------------------------------------------------------------------------

describe('readInstanceState', () => {
  it('returns null when the file is absent (ac-ae6f-1: missing-file read)', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    const state = await readInstanceState(3001, HOME, deps)
    assert.strictEqual(state, null)
  })

  it('parses + validates an on-disk state file', async () => {
    const path = instanceStatePath(3001, HOME)
    const fs = makeFakeFs({ [path]: JSON.stringify(fullValidState()) })
    const deps = makeDeps(fs)
    const state = await readInstanceState(3001, HOME, deps)
    assert.ok(state)
    assert.strictEqual(state!.instanceName, 'default')
    assert.strictEqual(state!.pid, 12345)
  })

  it('throws on malformed JSON', async () => {
    const path = instanceStatePath(3001, HOME)
    const fs = makeFakeFs({ [path]: '{ not json' })
    const deps = makeDeps(fs)
    await assert.rejects(
      () => readInstanceState(3001, HOME, deps),
      /not valid JSON/,
    )
  })

  it('throws on a state that fails validation', async () => {
    const path = instanceStatePath(3001, HOME)
    const fs = makeFakeFs({
      [path]: JSON.stringify({ instanceName: 'default' }),
    })
    const deps = makeDeps(fs)
    await assert.rejects(
      () => readInstanceState(3001, HOME, deps),
      /failed validation/,
    )
  })
})

// ---------------------------------------------------------------------------
// writeInstanceState
// ---------------------------------------------------------------------------

describe('writeInstanceState', () => {
  it('writes to <path>.tmp then renames onto target (ac-ae6f-1: atomic write-then-rename)', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    await writeInstanceState(fullValidState(), HOME, deps)

    const path = instanceStatePath(3001, HOME)
    const tmp = `${path}.tmp`

    // Final file present, tmp file gone.
    assert.ok(fs.files.has(path), 'final state file should exist')
    assert.ok(!fs.files.has(tmp), 'tmp file should have been renamed away')

    // Operation order: mkdir, then writeFile to tmp, then rename onto target.
    const writeOp = fs.ops.find((o) => o.kind === 'writeFile')
    const renameOp = fs.ops.find((o) => o.kind === 'rename')
    assert.ok(writeOp && writeOp.kind === 'writeFile')
    assert.strictEqual(writeOp.path, tmp, 'writeFile should target the tmp path')
    assert.ok(renameOp && renameOp.kind === 'rename')
    assert.strictEqual(renameOp.from, tmp)
    assert.strictEqual(renameOp.to, path)

    const writeIdx = fs.ops.indexOf(writeOp)
    const renameIdx = fs.ops.indexOf(renameOp)
    assert.ok(writeIdx < renameIdx, 'write to tmp must precede rename')
  })

  it('creates the state directory with mode 0700 (ac-ae6f-1: 0700 dir creation)', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    await writeInstanceState(fullValidState(), HOME, deps)

    const dir = instanceStateDir(HOME)
    assert.ok(fs.dirs.has(dir), 'state dir should be created')
    assert.strictEqual(
      fs.dirModes.get(dir),
      STATE_DIR_MODE,
      'state dir should be created with mode 0700',
    )
    assert.strictEqual(STATE_DIR_MODE, 0o700, 'STATE_DIR_MODE constant must be 0o700')
  })

  it('refuses to write a state that would fail validation', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    const bad = fullValidState() as InstanceState
    ;(bad as { apiPort: number }).apiPort = 99999
    await assert.rejects(
      () => writeInstanceState(bad, HOME, deps),
      /refusing to write/,
    )
    assert.strictEqual(fs.files.size, 0, 'no file should have been written')
  })

  it('round-trips through read', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    const original = fullValidState({
      apiPort: 4000,
      childPids: [99, 100],
    })
    await writeInstanceState(original, HOME, deps)
    const read = await readInstanceState(4000, HOME, deps)
    assert.deepStrictEqual(read, original)
  })
})

// ---------------------------------------------------------------------------
// removeInstanceState
// ---------------------------------------------------------------------------

describe('removeInstanceState', () => {
  it('deletes the state file when present', async () => {
    const path = instanceStatePath(3001, HOME)
    const fs = makeFakeFs({ [path]: JSON.stringify(fullValidState()) })
    const deps = makeDeps(fs)
    await removeInstanceState(3001, HOME, deps)
    assert.ok(!fs.files.has(path), 'state file should be removed')
  })

  it('is a no-op when the state file is absent', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    await removeInstanceState(3001, HOME, deps)
    // No throw, no unlink op recorded.
    assert.strictEqual(fs.ops.filter((o) => o.kind === 'unlink').length, 0)
  })
})

// ---------------------------------------------------------------------------
// listInstanceStates
// ---------------------------------------------------------------------------

describe('listInstanceStates', () => {
  it('returns [] when the state dir does not exist', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    const states = await listInstanceStates(HOME, deps)
    assert.deepStrictEqual(states, [])
  })

  it('lists every state across multiple apiPort-keyed files (ac-ae6f-1: listing across multiple apiPort-keyed files)', async () => {
    const fs = makeFakeFs({
      [instanceStatePath(3001, HOME)]: JSON.stringify(
        fullValidState({ instanceName: 'default', apiPort: 3001 }),
      ),
      [instanceStatePath(3002, HOME)]: JSON.stringify(
        fullValidState({ instanceName: 'scratch', apiPort: 3002, pid: 22222 }),
      ),
      [instanceStatePath(4000, HOME)]: JSON.stringify(
        fullValidState({ instanceName: 'side', apiPort: 4000, pid: 33333 }),
      ),
    })
    const deps = makeDeps(fs)
    const states = await listInstanceStates(HOME, deps)

    // Sorted by apiPort ascending.
    assert.strictEqual(states.length, 3)
    assert.deepStrictEqual(
      states.map((s) => s.apiPort),
      [3001, 3002, 4000],
    )
    assert.deepStrictEqual(
      states.map((s) => s.instanceName),
      ['default', 'scratch', 'side'],
    )
  })

  it('silently drops files with bad names or invalid contents', async () => {
    const fs = makeFakeFs({
      [instanceStatePath(3001, HOME)]: JSON.stringify(fullValidState()),
      // Wrong-shape filename: no parse, dropped.
      [`${instanceStateDir(HOME)}/.DS_Store`]: 'mac-junk',
      // Right shape, broken JSON: dropped via .catch(null).
      [`${instanceStateDir(HOME)}/4000.json`]: '{ not json',
      // Right shape, fails validation: dropped.
      [`${instanceStateDir(HOME)}/5000.json`]: JSON.stringify({ instanceName: 'x' }),
    })
    const deps = makeDeps(fs)
    const states = await listInstanceStates(HOME, deps)
    assert.strictEqual(states.length, 1)
    assert.strictEqual(states[0]!.apiPort, 3001)
  })
})
