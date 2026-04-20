/**
 * JSON Schema export for `WorkflowEvent`. Re-exports the TypeBox
 * schema under a JsonSchema-suffixed name so consumers can wire it
 * into output-format gates or emit it to a `$ref`-able document.
 */

export {
  WorkflowEventSchema as WorkflowEventJsonSchema,
  PhaseStatusChangedEventSchema as PhaseStatusChangedEventJsonSchema,
} from "../../validators/events/workflow-event.js";
