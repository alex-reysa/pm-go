import { describe, expect, it } from "vitest";

import { stripSchemaAnnotations } from "../src/planner-runner.js";

describe("stripSchemaAnnotations", () => {
  it("strips `$id` and `format` at the root schema position", () => {
    const schema = {
      $id: "Plan",
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
      },
      required: ["id"],
    };
    const stripped = stripSchemaAnnotations(schema);
    expect(stripped.$id).toBeUndefined();
    expect((stripped.properties as any).id.format).toBeUndefined();
    expect((stripped.properties as any).id.type).toBe("string");
  });

  it("preserves user-defined properties literally named `format` or `$id`", () => {
    // Regression: a key-blind walker would delete these. This is the
    // motivating bug for the schema-position-aware rewrite.
    const schema = {
      type: "object",
      properties: {
        $id: { type: "string", description: "User's chosen ID" },
        format: { type: "string", enum: ["pdf", "csv"] },
        plain: { type: "string" },
      },
      required: ["$id", "format"],
    };
    const stripped = stripSchemaAnnotations(schema);
    const props = stripped.properties as Record<string, unknown>;
    expect(props.$id).toBeDefined();
    expect((props.$id as any).type).toBe("string");
    expect(props.format).toBeDefined();
    expect((props.format as any).enum).toEqual(["pdf", "csv"]);
    expect(stripped.required).toEqual(["$id", "format"]);
  });

  it("recurses into anyOf/allOf/oneOf arrays", () => {
    const schema = {
      anyOf: [
        { $id: "Draft", type: "string", const: "draft" },
        { $id: "Approved", type: "string", format: "email", const: "approved" },
      ],
    };
    const stripped = stripSchemaAnnotations(schema);
    const variants = stripped.anyOf as Array<Record<string, unknown>>;
    expect(variants[0].$id).toBeUndefined();
    expect(variants[1].$id).toBeUndefined();
    expect(variants[1].format).toBeUndefined();
    expect(variants[0].const).toBe("draft");
    expect(variants[1].const).toBe("approved");
  });

  it("recurses into nested properties/items/definitions", () => {
    const schema = {
      $id: "Plan",
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            $id: "Task",
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
          },
        },
      },
      $defs: {
        Risk: { $id: "Risk", type: "object", properties: { lvl: { type: "string", format: "uuid" } } },
      },
    };
    const stripped = stripSchemaAnnotations(schema);
    expect(stripped.$id).toBeUndefined();
    const taskItems = (stripped.properties as any).tasks.items;
    expect(taskItems.$id).toBeUndefined();
    expect(taskItems.properties.id.format).toBeUndefined();
    const risk = (stripped.$defs as any).Risk;
    expect(risk.$id).toBeUndefined();
    expect(risk.properties.lvl.format).toBeUndefined();
  });

  it("leaves enum/const values verbatim even if they contain the word `format`", () => {
    // enum/const values are data, not schema nodes — walker must not
    // descend into them.
    const schema = {
      type: "string",
      enum: ["format", "$id", "other"],
    };
    const stripped = stripSchemaAnnotations(schema);
    expect(stripped.enum).toEqual(["format", "$id", "other"]);
  });

  it("is a no-op on schemas without `$id` or `format`", () => {
    const schema = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    expect(stripSchemaAnnotations(schema)).toEqual(schema);
  });
});
