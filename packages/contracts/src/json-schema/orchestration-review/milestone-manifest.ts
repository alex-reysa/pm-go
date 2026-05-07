/**
 * JSON Schema export for `MilestoneManifest`.
 *
 * The structured-output reference recorded on the decomposer
 * `AgentRun.outputFormatSchemaRef` is `"MilestoneManifest@1"`. Pass
 * `MilestoneManifestJsonSchema` directly to the Claude Agent SDK
 * adapter via `outputFormat: { type: "json_schema", schema }`.
 */

export { MilestoneManifestSchema as MilestoneManifestJsonSchema } from "../../validators/orchestration-review/milestone-manifest.js";
export { MilestoneSchema as MilestoneJsonSchema } from "../../validators/orchestration-review/milestone.js";
