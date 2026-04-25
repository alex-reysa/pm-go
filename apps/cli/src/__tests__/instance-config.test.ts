import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultInstanceName,
  instanceConfigPath,
  mergeInstanceConfig,
  validateInstanceConfig,
  readInstanceConfig,
  writeInstanceConfig,
  listInstances,
  type InstanceConfig,
  type InstanceConfigDeps,
} from '../lib/instance-config.js'

// ---------------------------------------------------------------------------
// Test helpers — fake filesystem
// ---------------------------------------------------------------------------

interface FakeFs {
  files: Map<string, string>
  /** Directories that exist (parents are added implicitly on mkdir). */
  dirs: Set<string>
}

function makeFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial))
  const dirs = new Set<string>()
  for (const path of files.keys()) {
    addParents(path, dirs)
  }
  return { files, dirs }
}

function addParents(path: string, dirs: Set<string>): void {
  const parts = path.split('/').filter(Boolean)
  let current = ''
  for (let i = 0; i < parts.length - 1; i++) {
    current += `/${parts[i]}`
    dirs.add(current)
  }
}

function makeDeps(fs: FakeFs): InstanceConfigDeps & {
  readdir: (path: string) => Promise<string[]>
} {
  return {
    readFile: async (path: string) => {
      const v = fs.files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    writeFile: async (path: string, content: string) => {
      addParents(path, fs.dirs)
      fs.files.set(path, content)
    },
    mkdir: async (path: string) => {
      // Mirror node's recursive mkdir: make every parent.
      const parts = path.split('/').filter(Boolean)
      let current = ''
      for (const p of parts) {
        current += `/${p}`
        fs.dirs.add(current)
      }
    },
    fileExists: async (path: string) => {
      return fs.files.has(path) || fs.dirs.has(path)
    },
    rename: async (a: string, b: string) => {
      const v = fs.files.get(a)
      if (v === undefined) throw new Error(`ENOENT: ${a}`)
      fs.files.delete(a)
      fs.files.set(b, v)
      addParents(b, fs.dirs)
    },
    readdir: async (path: string) => {
      const out = new Set<string>()
      const prefix = path.endsWith('/') ? path : `${path}/`
      for (const f of fs.files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length)
          const head = rest.split('/')[0]
          if (head) out.add(head)
        }
      }
      for (const d of fs.dirs) {
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length)
          const head = rest.split('/')[0]
          if (head) out.add(head)
        }
      }
      return [...out]
    },
  }
}

const HOME = '/home/user'

function fullValidConfig(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    name: 'default',
    repoRoot: '/abs/repo',
    monorepoRoot: '/abs/pm-go',
    createdAt: '2026-04-25T12:00:00.000Z',
    api: { port: 3001 },
    database: { url: 'postgres://pmgo:pmgo@localhost:5432/pm_go' },
    temporal: { taskQueue: 'pm-go', address: 'localhost:7233' },
    runtime: 'auto',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// defaultInstanceName + instanceConfigPath (pure helpers)
// ---------------------------------------------------------------------------

describe('defaultInstanceName', () => {
  it('returns "default"', () => {
    assert.strictEqual(defaultInstanceName(), 'default')
  })
})

describe('instanceConfigPath', () => {
  it('builds <homeDir>/.pm-go/instances/<name>/config.json', () => {
    assert.strictEqual(
      instanceConfigPath('default', '/home/u'),
      '/home/u/.pm-go/instances/default/config.json',
    )
  })

  it('strips a single trailing slash from homeDir', () => {
    assert.strictEqual(
      instanceConfigPath('scratch', '/home/u/'),
      '/home/u/.pm-go/instances/scratch/config.json',
    )
  })

  it('rejects names containing a slash', () => {
    assert.throws(() => instanceConfigPath('a/b', HOME), /may not contain/)
  })

  it("rejects names containing '..'", () => {
    assert.throws(() => instanceConfigPath('a..b', HOME), /\.\./)
  })

  it("rejects names starting with '.'", () => {
    assert.throws(() => instanceConfigPath('.hidden', HOME), /start with/)
  })

  it('rejects names longer than 64 chars', () => {
    const long = 'x'.repeat(65)
    assert.throws(() => instanceConfigPath(long, HOME), /too long/)
  })

  it('rejects empty name', () => {
    assert.throws(() => instanceConfigPath('', HOME), /non-empty/)
  })

  it('rejects empty homeDir', () => {
    assert.throws(() => instanceConfigPath('default', ''), /homeDir/)
  })
})

// ---------------------------------------------------------------------------
// mergeInstanceConfig
// ---------------------------------------------------------------------------

describe('mergeInstanceConfig', () => {
  const baseRequired = {
    repoRoot: '/abs/repo',
    monorepoRoot: '/abs/pm-go',
    createdAt: '2026-04-25T12:00:00.000Z',
  }

  it('fills in defaults for api/database/temporal/runtime when nothing is set', () => {
    const cfg = mergeInstanceConfig(null, { name: 'default', ...baseRequired })
    assert.strictEqual(cfg.name, 'default')
    assert.strictEqual(cfg.api.port, 3001)
    assert.strictEqual(cfg.database.url, 'postgres://pmgo:pmgo@localhost:5432/pm_go')
    assert.strictEqual(cfg.temporal.taskQueue, 'pm-go')
    assert.strictEqual(cfg.temporal.address, 'localhost:7233')
    assert.strictEqual(cfg.runtime, 'auto')
  })

  it('updates win over existing values', () => {
    const existing = fullValidConfig({ api: { port: 4000 } })
    const cfg = mergeInstanceConfig(existing, {
      api: { port: 5000 },
      runtime: 'sdk',
    })
    assert.strictEqual(cfg.api.port, 5000)
    assert.strictEqual(cfg.runtime, 'sdk')
    // Untouched fields survive from existing.
    assert.strictEqual(cfg.repoRoot, '/abs/repo')
  })

  it('shallow-merges sub-objects so partial updates do not wipe siblings', () => {
    const existing = fullValidConfig()
    const cfg = mergeInstanceConfig(existing, {
      temporal: { taskQueue: 'special-queue', address: 'localhost:7233' },
    })
    assert.strictEqual(cfg.temporal.taskQueue, 'special-queue')
    assert.strictEqual(cfg.temporal.address, 'localhost:7233')
    assert.strictEqual(cfg.database.url, existing.database.url)
  })

  it('throws when required fields (repoRoot, monorepoRoot, createdAt) are missing', () => {
    assert.throws(
      () => mergeInstanceConfig(null, { name: 'x' }),
      /missing required field/,
    )
  })

  it('preserves optional fields when provided in updates', () => {
    const cfg = mergeInstanceConfig(null, {
      name: 'default',
      ...baseRequired,
      lastStartedAt: '2026-04-25T13:00:00.000Z',
      artifactDir: '/abs/artifacts',
    })
    assert.strictEqual(cfg.lastStartedAt, '2026-04-25T13:00:00.000Z')
    assert.strictEqual(cfg.artifactDir, '/abs/artifacts')
  })

  it('rejects an invalid name in the merged result', () => {
    assert.throws(
      () => mergeInstanceConfig(null, { name: '../escape', ...baseRequired }),
      /name/,
    )
  })
})

// ---------------------------------------------------------------------------
// validateInstanceConfig
// ---------------------------------------------------------------------------

describe('validateInstanceConfig', () => {
  it('accepts a full valid config', () => {
    const r = validateInstanceConfig(fullValidConfig())
    assert.ok(r.ok, JSON.stringify(r))
    assert.strictEqual(r.config.name, 'default')
  })

  it('accepts a config with optional fields populated', () => {
    const r = validateInstanceConfig(
      fullValidConfig({
        lastStartedAt: '2026-04-25T13:00:00.000Z',
        artifactDir: '/abs/art',
        worktreeRoot: '/abs/wt',
      }),
    )
    assert.ok(r.ok)
    assert.strictEqual(r.config.artifactDir, '/abs/art')
    assert.strictEqual(r.config.worktreeRoot, '/abs/wt')
  })

  it('rejects non-object inputs with a single error', () => {
    const r = validateInstanceConfig('not an object')
    assert.ok(!r.ok)
    assert.strictEqual(r.errors.length, 1)
    assert.match(r.errors[0]!, /JSON object/)
  })

  it('rejects a missing required field', () => {
    const cfg = fullValidConfig() as unknown as Record<string, unknown>
    delete cfg.repoRoot
    const r = validateInstanceConfig(cfg)
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /repoRoot/.test(e)))
  })

  it('rejects an invalid api.port (out of range)', () => {
    const r = validateInstanceConfig(fullValidConfig({ api: { port: 99999 } }))
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /api\.port/.test(e)))
  })

  it('rejects an unknown runtime value', () => {
    const cfg = fullValidConfig() as unknown as Record<string, unknown>
    cfg.runtime = 'magic'
    const r = validateInstanceConfig(cfg)
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /runtime/.test(e)))
  })

  it('rejects a missing nested temporal field', () => {
    const cfg = fullValidConfig() as unknown as Record<string, unknown>
    cfg.temporal = { taskQueue: 'pm-go' }
    const r = validateInstanceConfig(cfg)
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /temporal\.address/.test(e)))
  })

  it('aggregates multiple errors instead of failing fast', () => {
    const cfg = fullValidConfig() as unknown as Record<string, unknown>
    delete cfg.repoRoot
    delete cfg.monorepoRoot
    const r = validateInstanceConfig(cfg)
    assert.ok(!r.ok)
    assert.ok(r.errors.length >= 2)
  })
})

// ---------------------------------------------------------------------------
// readInstanceConfig
// ---------------------------------------------------------------------------

describe('readInstanceConfig', () => {
  it('returns null when the file is absent', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    const cfg = await readInstanceConfig('default', HOME, deps)
    assert.strictEqual(cfg, null)
  })

  it('parses + validates an on-disk config file', async () => {
    const path = instanceConfigPath('default', HOME)
    const fs = makeFakeFs({
      [path]: JSON.stringify(fullValidConfig()),
    })
    const deps = makeDeps(fs)
    const cfg = await readInstanceConfig('default', HOME, deps)
    assert.ok(cfg)
    assert.strictEqual(cfg!.name, 'default')
    assert.strictEqual(cfg!.api.port, 3001)
  })

  it('throws on malformed JSON', async () => {
    const path = instanceConfigPath('default', HOME)
    const fs = makeFakeFs({ [path]: '{ not json' })
    const deps = makeDeps(fs)
    await assert.rejects(
      () => readInstanceConfig('default', HOME, deps),
      /not valid JSON/,
    )
  })

  it('throws on a config that fails validation', async () => {
    const path = instanceConfigPath('default', HOME)
    const fs = makeFakeFs({
      [path]: JSON.stringify({ name: 'default' }), // missing required fields
    })
    const deps = makeDeps(fs)
    await assert.rejects(
      () => readInstanceConfig('default', HOME, deps),
      /failed validation/,
    )
  })
})

// ---------------------------------------------------------------------------
// writeInstanceConfig
// ---------------------------------------------------------------------------

describe('writeInstanceConfig', () => {
  it('creates the parent dir, writes pretty JSON, and renames atomically', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    const cfg = fullValidConfig()
    await writeInstanceConfig(cfg, HOME, deps)

    const path = instanceConfigPath('default', HOME)
    const tmp = `${path}.tmp`
    assert.ok(fs.files.has(path), 'final config.json should exist')
    assert.ok(!fs.files.has(tmp), 'tmp file should have been renamed')
    const dir = path.slice(0, -'/config.json'.length)
    assert.ok(fs.dirs.has(dir), 'instance dir should be created')
    const body = fs.files.get(path)!
    // Pretty-printed: contains newlines + 2-space indents.
    assert.ok(body.includes('\n'))
    assert.ok(body.includes('  '))
    // Round-trips back to the same config.
    const parsed = JSON.parse(body)
    assert.strictEqual(parsed.runtime, 'auto')
    assert.strictEqual(parsed.api.port, 3001)
  })

  it('refuses to write a config that would fail validation', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    const bad = fullValidConfig() as InstanceConfig
    // Force an out-of-range port.
    ;(bad as { api: { port: number } }).api.port = 99999
    await assert.rejects(
      () => writeInstanceConfig(bad, HOME, deps),
      /refusing to write/,
    )
    assert.strictEqual(fs.files.size, 0, 'no file should have been written')
  })
})

// ---------------------------------------------------------------------------
// listInstances
// ---------------------------------------------------------------------------

describe('listInstances', () => {
  it('returns [] when ~/.pm-go/instances does not exist', async () => {
    const fs = makeFakeFs()
    const deps = makeDeps(fs)
    const names = await listInstances(HOME, deps)
    assert.deepStrictEqual(names, [])
  })

  it('lists every instance with a valid config.json', async () => {
    const fs = makeFakeFs({
      [instanceConfigPath('default', HOME)]: JSON.stringify(
        fullValidConfig({ name: 'default' }),
      ),
      [instanceConfigPath('scratch', HOME)]: JSON.stringify(
        fullValidConfig({ name: 'scratch', api: { port: 3002 } }),
      ),
    })
    const deps = makeDeps(fs)
    const names = await listInstances(HOME, deps)
    assert.deepStrictEqual(names, ['default', 'scratch'])
  })

  it('silently drops entries with invalid config files', async () => {
    const fs = makeFakeFs({
      [instanceConfigPath('default', HOME)]: JSON.stringify(fullValidConfig()),
      [instanceConfigPath('broken', HOME)]: '{ not json',
      [instanceConfigPath('halfbroken', HOME)]: JSON.stringify({ name: 'halfbroken' }),
    })
    const deps = makeDeps(fs)
    const names = await listInstances(HOME, deps)
    assert.deepStrictEqual(names, ['default'])
  })
})
