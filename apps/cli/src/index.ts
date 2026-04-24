#!/usr/bin/env node
/**
 * pm-go CLI entrypoint.
 *
 * Usage:
 *   node apps/cli/src/index.ts doctor
 *   pm-go doctor          (via bin entry-point after build)
 */

import { detectAvailableRuntimes } from '@pm-go/runtime-detector'
import { runDoctor } from './doctor.js'

const [, , subcommand, ...rest] = process.argv

switch (subcommand) {
  case 'doctor': {
    void (async () => {
      const exitCode = await runDoctor({
        detectRuntimes: detectAvailableRuntimes,
        env: process.env,
        write: console.log,
      })
      process.exit(exitCode)
    })()
    break
  }

  default: {
    console.error(`Unknown subcommand: ${subcommand ?? '(none)'}`)
    console.error('Usage: pm-go doctor')
    process.exit(1)
  }
}
