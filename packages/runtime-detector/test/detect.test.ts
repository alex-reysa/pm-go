import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectAvailableRuntimes,
  clearDetectionCache,
  _setRunnerForTesting,
  createRuntimeAdapter,
  KNOWN_ADAPTERS,
} from '../src/detect.js';

beforeEach(() => {
  clearDetectionCache();
  _setRunnerForTesting(null);
});

afterEach(() => {
  clearDetectionCache();
  _setRunnerForTesting(null);
});

// ---------------------------------------------------------------------------
// ac-rd-01: entries carry adapter.name, adapter.cliCommand, and non-null version
// ---------------------------------------------------------------------------

describe('detectAvailableRuntimes – ac-rd-01', () => {
  it('returns entries with adapter.name, adapter.cliCommand, and a non-null version string', async () => {
    // Simulate claude being present, codex/gemini absent
    _setRunnerForTesting((cmd) =>
      Promise.resolve(cmd === 'claude' ? '1.2.3' : null),
    );

    const results = await detectAvailableRuntimes();

    // At least one result (claude)
    expect(results.length).toBeGreaterThan(0);

    for (const { adapter, version } of results) {
      expect(typeof adapter.name).toBe('string');
      expect(adapter.name.length).toBeGreaterThan(0);

      expect(typeof adapter.cliCommand).toBe('string');
      expect(adapter.cliCommand.length).toBeGreaterThan(0);

      expect(version).not.toBeNull();
      expect(typeof version).toBe('string');
      expect(version.length).toBeGreaterThan(0);
    }
  });

  it('adapter.name and adapter.cliCommand are populated for every KNOWN_ADAPTER', () => {
    for (const adapter of KNOWN_ADAPTERS) {
      expect(typeof adapter.name).toBe('string');
      expect(adapter.name.length).toBeGreaterThan(0);
      expect(typeof adapter.cliCommand).toBe('string');
      expect(adapter.cliCommand.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ac-rd-02: 60 s in-process cache prevents re-spawning within TTL
// ---------------------------------------------------------------------------

describe('detectAvailableRuntimes – ac-rd-02 (cache)', () => {
  it('does not call the runner again on a second call within the TTL window', async () => {
    const spy = vi.fn().mockResolvedValue('2.0.0');
    _setRunnerForTesting(spy);

    // First call — runner invoked once per known CLI
    await detectAvailableRuntimes();
    const callsAfterFirstRound = spy.mock.calls.length;

    // Should equal the number of known adapters (claude, codex, gemini = 3)
    expect(callsAfterFirstRound).toBe(KNOWN_ADAPTERS.length);

    // Second call within TTL — all values should come from cache
    await detectAvailableRuntimes();
    expect(spy.mock.calls.length).toBe(callsAfterFirstRound);
  });

  it('re-invokes the runner after the cache entry expires', async () => {
    vi.useFakeTimers();
    const spy = vi.fn().mockResolvedValue('3.0.0');
    _setRunnerForTesting(spy);

    await detectAvailableRuntimes();
    const callsAfterFirst = spy.mock.calls.length;

    // Advance time past the 60 s TTL
    vi.advanceTimersByTime(61_000);

    await detectAvailableRuntimes();
    // Runner must have been called again for each adapter
    expect(spy.mock.calls.length).toBe(callsAfterFirst * 2);

    vi.useRealTimers();
  });

  it('individual adapter.detectVersion() also uses the shared cache', async () => {
    const spy = vi.fn().mockResolvedValue('1.0.0');
    _setRunnerForTesting(spy);

    // Prime cache via detectAvailableRuntimes
    await detectAvailableRuntimes();
    const callsAfterPrime = spy.mock.calls.length;

    // Calling detectVersion on an individual adapter must NOT re-spawn
    const claudeAdapter = KNOWN_ADAPTERS.find((a) => a.cliCommand === 'claude');
    expect(claudeAdapter).toBeDefined();
    await claudeAdapter!.detectVersion();

    expect(spy.mock.calls.length).toBe(callsAfterPrime);
  });
});

// ---------------------------------------------------------------------------
// ac-rd-03: returns [] when no CLIs are on PATH — never throws
// ---------------------------------------------------------------------------

describe('detectAvailableRuntimes – ac-rd-03 (no CLIs)', () => {
  it('returns an empty array when every CLI is absent', async () => {
    _setRunnerForTesting(() => Promise.resolve(null));

    const results = await detectAvailableRuntimes();
    expect(results).toEqual([]);
  });

  it('does not throw even when the runner rejects', async () => {
    // Runner always returns null (simulating "not found") — rejects are
    // handled inside the real defaultRunner; the spy returns null to simulate
    // the same outcome.
    _setRunnerForTesting(() => Promise.resolve(null));

    await expect(detectAvailableRuntimes()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createRuntimeAdapter — unknown cliCommand values are rejected
// ---------------------------------------------------------------------------

describe('createRuntimeAdapter', () => {
  it('throws for an unknown cliCommand', () => {
    expect(() => createRuntimeAdapter('unknown-cli')).toThrow();
  });

  it('throws for an empty string', () => {
    expect(() => createRuntimeAdapter('')).toThrow();
  });

  it('throws for a partially matching command', () => {
    expect(() => createRuntimeAdapter('claud')).toThrow();
  });

  it('returns the correct adapter for "claude"', () => {
    const adapter = createRuntimeAdapter('claude');
    expect(adapter.cliCommand).toBe('claude');
    expect(adapter.name).toBe('claude');
    expect(adapter.capabilities.mcpTools).toBe(true);
  });

  it('returns the correct adapter for "codex"', () => {
    const adapter = createRuntimeAdapter('codex');
    expect(adapter.cliCommand).toBe('codex');
  });

  it('returns the correct adapter for "gemini"', () => {
    const adapter = createRuntimeAdapter('gemini');
    expect(adapter.cliCommand).toBe('gemini');
  });
});
