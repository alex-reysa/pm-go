/**
 * Barrel for `fixtures/core/*.json`. Fixtures are JSON files on disk;
 * consumers load them via `fs.readFileSync` + `JSON.parse` (or an
 * equivalent mechanism appropriate for their runtime) to avoid taking
 * a hard dependency on a specific bundler or import-attributes mode.
 *
 * The fixture file paths are re-exported from here so tests and tools
 * can resolve them without hard-coding directory structure.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const specDocumentFixturePath = join(here, "spec-document.json");
export const repoSnapshotFixturePath = join(here, "repo-snapshot.json");
export const agentRunFixturePath = join(here, "agent-run.json");
