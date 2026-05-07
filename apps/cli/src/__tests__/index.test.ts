import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveCliDispatch } from '../index.js'

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
