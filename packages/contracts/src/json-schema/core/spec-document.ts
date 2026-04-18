/**
 * JSON Schema export for `SpecDocument`. TypeBox schemas ARE JSON
 * Schema at runtime; re-exporting the schema object keeps the
 * validator and JSON Schema definitions in lockstep by construction.
 */
export { SpecDocumentSchema as SpecDocumentJsonSchema } from "../../validators/core/spec-document.js";
