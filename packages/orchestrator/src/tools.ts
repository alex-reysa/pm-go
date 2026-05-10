import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { UUID } from "@pm-go/contracts";
import { z } from "zod";

import type { AgentRunPersistence } from "./persistence.js";
import type { OperatorAgentOptions, ToolCallRecord } from "./types.js";

export const PMGO_TOOL_NAMES = [
  "pmgo_doctor",
  "pmgo_recover",
  "pmgo_ensure_stack",
  "pmgo_stop",
  "pmgo_submit_spec",
  "pmgo_decompose_spec",
  "pmgo_update_manifest",
  "pmgo_plan_first",
  "pmgo_drive_plan",
  "pmgo_status",
  "pmgo_why",
  "pmgo_tail_events",
  "pmgo_approve_pending",
] as const;

export type PmGoToolName = (typeof PMGO_TOOL_NAMES)[number];

export type ToolHandlerResult = Record<string, unknown>;
type SdkToolResult = { content: Array<{ type: "text"; text: string }> };

export interface PmGoToolHandlers {
  doctor?: (input: { repair?: boolean | undefined; verbose?: boolean | undefined }) => Promise<ToolHandlerResult>;
  recover?: () => Promise<ToolHandlerResult>;
  ensureStack?: (input: { repoRoot?: string | undefined; runtime?: string | undefined; apiUrl: string }) => Promise<ToolHandlerResult>;
  stop?: () => Promise<ToolHandlerResult>;
  updateManifest?: (input: {
    planId: string;
    reason: string;
    approved?: boolean | undefined;
  }) => Promise<ToolHandlerResult>;
  planFirst?: (input: { planId: string }) => Promise<ToolHandlerResult>;
  drivePlan?: (input: {
    planId: string;
    approve: "all" | "none" | "interactive";
  }) => Promise<ToolHandlerResult>;
  why?: (input: { id: string }) => Promise<ToolHandlerResult>;
}

export interface PmGoSdkToolsInput {
  agentRunId: UUID;
  options: OperatorAgentOptions;
  persistence: AgentRunPersistence;
  fetchImpl?: typeof globalThis.fetch;
  handlers?: PmGoToolHandlers;
  now?: () => Date;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  planWaitMs?: number;
  planPollIntervalMs?: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPmGoSdkMcpServer(input: PmGoSdkToolsInput) {
  const tools = createPmGoSdkTools(input);
  return createSdkMcpServer({
    name: "pm-go",
    version: "1.0.0",
    tools,
  });
}

export function createPmGoSdkTools(input: PmGoSdkToolsInput) {
  const runtime = createToolRuntime(input);
  return [
    tool(
      "pmgo_doctor",
      "Probe pm-go runtime, auth, and infra health. Optionally repair auto-fixable local infra.",
      {
        repair: z.boolean().optional(),
        verbose: z.boolean().optional(),
      },
      runtime.wrap("pmgo_doctor", async (args) => {
        if (input.handlers?.doctor) return input.handlers.doctor(args);
        return {
          status: "unavailable",
          message: "doctor requires CLI-provided local handler",
        };
      }),
    ),
    tool(
      "pmgo_recover",
      "Sweep stale pm-go process state so a fresh supervisor can boot cleanly.",
      {},
      runtime.wrap("pmgo_recover", async () => {
        if (input.handlers?.recover) return input.handlers.recover();
        return {
          status: "unavailable",
          message: "recover requires CLI-provided local handler",
        };
      }),
    ),
    tool(
      "pmgo_ensure_stack",
      "Ensure the pm-go API/control plane is reachable for this repo and runtime.",
      {
        repoRoot: z.string().optional(),
        runtime: z.enum(["auto", "stub", "sdk", "claude"]).optional(),
      },
      runtime.wrap("pmgo_ensure_stack", async (args) => {
        const repoRoot = resolveScopedRepoRoot(input.options, args.repoRoot);
        if (typeof repoRoot !== "string") return repoRoot.error;
        if (input.handlers?.ensureStack) {
          return input.handlers.ensureStack({
            repoRoot,
            runtime: args.runtime ?? input.options.runtime,
            apiUrl: resolveApiUrl(input.options),
          });
        }
        const health = await runtime.fetchJson(runtime.apiUrl("/health"));
        return { status: "reachable", health };
      }),
    ),
    tool(
      "pmgo_stop",
      "Stop pm-go-owned local control-plane processes.",
      {},
      runtime.wrap("pmgo_stop", async () => {
        if (input.handlers?.stop) return input.handlers.stop();
        return {
          status: "unavailable",
          message: "stop requires CLI-provided local handler",
        };
      }),
    ),
    tool(
      "pmgo_submit_spec",
      "Create a spec document and repo snapshot through the pm-go API.",
      {
        repoRoot: z.string().optional(),
        specPath: z.string().optional(),
        title: z.string().optional(),
      },
      runtime.wrap("pmgo_submit_spec", async (args) => {
        const repoRoot = resolveScopedRepoRoot(input.options, args.repoRoot);
        if (typeof repoRoot !== "string") return repoRoot.error;
        const specPath = resolveScopedSpecPath(input.options, args.specPath);
        if (typeof specPath !== "string") return specPath.error;
        const body = await readFile(specPath, "utf8");
        const title =
          args.title ??
          input.options.title ??
          deriveTitle(body, specPath);
        return runtime.postJson(runtime.apiUrl("/spec-documents"), {
          repoRoot,
          title,
          body,
          source: "manual",
        });
      }),
    ),
    tool(
      "pmgo_decompose_spec",
      "Start planner/decomposition for a submitted spec document and repo snapshot.",
      {
        specDocumentId: z.string().regex(UUID_RE),
        repoSnapshotId: z.string().regex(UUID_RE),
      },
      runtime.wrap("pmgo_decompose_spec", async (args) => {
        const started = await runtime.postJson(runtime.apiUrl("/plans"), {
          specDocumentId: args.specDocumentId,
          repoSnapshotId: args.repoSnapshotId,
          requestedBy: "operator-orchestrator",
        });
        return runtime.waitForPlanPersistence({
          started,
          specDocumentId: args.specDocumentId,
          repoSnapshotId: args.repoSnapshotId,
        });
      }),
    ),
    tool(
      "pmgo_update_manifest",
      "Record or apply an operator-approved manifest/decomposition update.",
      {
        planId: z.string().regex(UUID_RE),
        reason: z.string().min(1),
        approved: z.boolean().optional(),
      },
      runtime.wrap("pmgo_update_manifest", async (args) => {
        if (input.handlers?.updateManifest) return input.handlers.updateManifest(args);
        return {
          status: "requires_operator",
          message: "manifest updates require an explicit pm-go implementation handler",
          planId: args.planId,
          reason: args.reason,
        };
      }),
    ),
    tool(
      "pmgo_plan_first",
      "Inspect the first executable phase/tasks for a plan before driving.",
      {
        planId: z.string().regex(UUID_RE),
      },
      runtime.wrap("pmgo_plan_first", async (args) => {
        if (input.handlers?.planFirst) return input.handlers.planFirst(args);
        const plan = await runtime.fetchJson(runtime.apiUrl(`/plans/${args.planId}`));
        return summarizePlanFirst(plan);
      }),
    ),
    tool(
      "pmgo_drive_plan",
      "Drive a pm-go plan through execution, review, integration, audit, and release.",
      {
        planId: z.string().regex(UUID_RE),
        approve: z.enum(["all", "none", "interactive"]).optional(),
      },
      runtime.wrap("pmgo_drive_plan", async (args) => {
        const approve = input.options.approve;
        if (args.approve !== undefined && args.approve !== approve) {
          return {
            status: "rejected",
            message:
              "pmgo_drive_plan may not override the operator-selected approval policy",
            requestedApprove: args.approve,
            effectiveApprove: approve,
          };
        }
        if (input.handlers?.drivePlan) {
          return input.handlers.drivePlan({ planId: args.planId, approve });
        }
        return {
          status: "unavailable",
          message: "drive requires CLI-provided local handler",
          planId: args.planId,
          approve,
        };
      }),
    ),
    tool(
      "pmgo_status",
      "Read pm-go API health and recent plans.",
      {
        planId: z.string().regex(UUID_RE).optional(),
      },
      runtime.wrap("pmgo_status", async (args) => {
        const health = await runtime.fetchJson(runtime.apiUrl("/health"));
        if (args.planId) {
          const plan = await runtime.fetchJson(runtime.apiUrl(`/plans/${args.planId}`));
          return { health, plan };
        }
        const plans = await runtime.fetchJson(runtime.apiUrl("/plans"));
        return { health, plans };
      }),
    ),
    tool(
      "pmgo_why",
      "Explain why a plan, phase, or task is in its current state.",
      {
        id: z.string().regex(UUID_RE),
      },
      runtime.wrap("pmgo_why", async (args) => {
        if (input.handlers?.why) return input.handlers.why(args);
        return defaultWhy(runtime, args.id);
      }),
    ),
    tool(
      "pmgo_tail_events",
      "Fetch recent workflow events for a plan.",
      {
        planId: z.string().regex(UUID_RE),
        sinceEventId: z.string().regex(UUID_RE).optional(),
      },
      runtime.wrap("pmgo_tail_events", async (args) => {
        const q = args.sinceEventId
          ? `?planId=${args.planId}&sinceEventId=${args.sinceEventId}`
          : `?planId=${args.planId}`;
        return runtime.fetchJson(runtime.apiUrl(`/events${q}`)) as Promise<ToolHandlerResult>;
      }),
    ),
    tool(
      "pmgo_approve_pending",
      "Approve pending low-risk/high-risk plan approvals when allowed by operator policy.",
      {
        planId: z.string().regex(UUID_RE),
        reason: z.string().min(1).optional(),
      },
      runtime.wrap("pmgo_approve_pending", async (args) => {
        if (input.options.approve === "none") {
          return {
            status: "requires_confirmation",
            message:
              "operator selected --approve none; approve pending requests manually",
            planId: args.planId,
          };
        }
        const approvalsBody = await runtime.fetchJson(runtime.apiUrl(`/approvals?planId=${args.planId}`));
        const approvals = Array.isArray((approvalsBody as { approvals?: unknown[] }).approvals)
          ? ((approvalsBody as { approvals: Array<Record<string, unknown>> }).approvals)
          : [];
        const pending = approvals.filter((row) => row.status === "pending");
        const highRisk = pending.filter((row) => row.riskBand === "high" || row.riskBand === "catastrophic");
        if (highRisk.length > 0 && !input.options.yes) {
          return {
            status: "requires_confirmation",
            message: "pending high-risk approvals require explicit user confirmation or --yes",
            pendingCount: pending.length,
            highRiskCount: highRisk.length,
          };
        }
        return runtime.postJson(runtime.apiUrl(`/plans/${args.planId}/approve-all-pending`), {
          approvedBy: "operator-orchestrator",
          reason: args.reason ?? "operator orchestrator approval",
        });
      }),
    ),
  ];
}

function createToolRuntime(input: PmGoSdkToolsInput) {
  let sequence = 0;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = input.now ?? (() => new Date());
  const nowMs = input.nowMs ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const planWaitMs = input.planWaitMs ?? 45 * 60_000;
  const planPollIntervalMs = input.planPollIntervalMs ?? 1_000;
  const apiBase = resolveApiUrl(input.options);

  async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const res = await fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${text}`);
    }
    return res.json().catch(() => ({}));
  }

  async function postJson(url: string, body: unknown): Promise<ToolHandlerResult> {
    return (await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })) as ToolHandlerResult;
  }

  async function waitForPlanPersistence(input: {
    started: ToolHandlerResult;
    specDocumentId: string;
    repoSnapshotId: string;
  }): Promise<ToolHandlerResult> {
    const planId = extractPlanId(input.started);
    if (!planId) {
      return input.started;
    }
    const deadline = nowMs() + planWaitMs;
    let lastStatus = 0;
    let lastBody = "";
    while (nowMs() <= deadline) {
      const res = await fetchImpl(apiUrl(`/plans/${planId}`));
      lastStatus = res.status;
      if (res.ok) {
        const plan = await res.json().catch(() => ({}));
        return {
          status: "ready",
          planId,
          specDocumentId: input.specDocumentId,
          repoSnapshotId: input.repoSnapshotId,
          plan,
        };
      }
      lastBody = await res.text().catch(() => "");
      if (res.status !== 404) {
        throw new Error(`GET ${apiUrl(`/plans/${planId}`)} -> ${res.status}: ${lastBody}`);
      }
      const remaining = deadline - nowMs();
      if (remaining <= 0) break;
      await sleep(Math.min(planPollIntervalMs, remaining));
    }
    return {
      status: "planning",
      planId,
      specDocumentId: input.specDocumentId,
      repoSnapshotId: input.repoSnapshotId,
      workflowId: `plan-${input.specDocumentId}`,
      message:
        "plan row is not queryable yet; the SpecToPlanWorkflow may still be running",
      lastStatus,
      ...(lastBody ? { lastBody } : {}),
    };
  }

  function apiUrl(suffix: string): string {
    return `${apiBase}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  }

  function wrap<T extends Record<string, unknown>>(
    toolName: PmGoToolName,
    handler: (args: T) => Promise<ToolHandlerResult>,
  ): (args: T, extra: unknown) => Promise<SdkToolResult> {
    return async (args: T) => {
      const startedAt = now().toISOString();
      const record: ToolCallRecord = {
        id: randomUUID(),
        agentRunId: input.agentRunId,
        sequence: sequence++,
        toolName,
        sanitizedInput: sanitizeJson(args),
        status: "running",
        startedAt,
        ...extractRefs(args),
      };
      await input.persistence.createToolCall(record);

      try {
        const output = await handler(args);
        const completed: ToolCallRecord = {
          ...record,
          status: "completed",
          summarizedOutput: summarizeJson(output),
          completedAt: now().toISOString(),
          ...extractOutputRefs(toolName, output),
        };
        await input.persistence.updateToolCall(completed);
        if (completed.planId) {
          await input.persistence.linkRunToPlan({
            agentRunId: input.agentRunId,
            planId: completed.planId,
          });
        }
        return jsonResult(output);
      } catch (err) {
        const failed: ToolCallRecord = {
          ...record,
          status: "failed",
          errorReason: err instanceof Error ? err.message : String(err),
          completedAt: now().toISOString(),
        };
        await input.persistence.updateToolCall(failed);
        return jsonResult({
          status: "failed",
          error: failed.errorReason,
        });
      }
    };
  }

  return { apiUrl, fetchJson, postJson, waitForPlanPersistence, wrap };
}

function resolveApiUrl(options: OperatorAgentOptions): string {
  return (
    options.apiUrl?.replace(/\/+$/, "") ??
    `http://127.0.0.1:${options.apiPort ?? 3001}`
  );
}

function jsonResult(value: unknown): SdkToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function deriveTitle(body: string, specPath: string): string {
  const h1 = body
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
    .find((line): line is string => typeof line === "string" && line.length > 0);
  return h1 ?? path.basename(specPath).replace(/\.[^.]+$/, "");
}

function resolveScopedRepoRoot(
  options: OperatorAgentOptions,
  requested: string | undefined,
):
  | { error: ToolHandlerResult }
  | string {
  if (!options.repoRoot) {
    return { error: { status: "needs_input", message: "repoRoot is required" } };
  }
  const allowedRoot = path.resolve(options.repoRoot);
  const repoRoot = requested === undefined ? allowedRoot : path.resolve(requested);
  if (repoRoot !== allowedRoot && !isInsidePath(repoRoot, allowedRoot)) {
    return {
      error: {
        status: "rejected",
        message: "repoRoot must stay within the operator-provided repo root",
        requestedRepoRoot: repoRoot,
        allowedRepoRoot: allowedRoot,
      },
    };
  }
  return repoRoot;
}

function resolveScopedSpecPath(
  options: OperatorAgentOptions,
  requested: string | undefined,
):
  | { error: ToolHandlerResult }
  | string {
  if (!options.specPath) {
    return { error: { status: "needs_input", message: "specPath is required" } };
  }
  const allowedSpecPath = path.resolve(options.specPath);
  const specPath = requested === undefined ? allowedSpecPath : path.resolve(requested);
  if (specPath !== allowedSpecPath) {
    return {
      error: {
        status: "rejected",
        message:
          "specPath must match the operator-provided spec path; root agent reads are constrained",
        requestedSpecPath: specPath,
        allowedSpecPath,
      },
    };
  }
  return specPath;
}

function isInsidePath(target: string, root: string): boolean {
  const absTarget = path.resolve(target);
  const absRoot = path.resolve(root);
  return absTarget === absRoot || absTarget.startsWith(absRoot + path.sep);
}

function summarizePlanFirst(planResponse: unknown): ToolHandlerResult {
  const body = planResponse as {
    plan?: {
      id?: string;
      status?: string;
      phases?: Array<{ id: string; index: number; title: string; status: string; mergeOrder?: string[] }>;
      tasks?: Array<{ id: string; phaseId: string; title: string; status: string }>;
    };
  };
  const plan = body.plan;
  if (!plan) return { status: "unknown", planResponse };
  const firstOpen = (plan.phases ?? []).find((p) => p.status !== "completed");
  const tasks = firstOpen
    ? (plan.tasks ?? []).filter((t) => t.phaseId === firstOpen.id)
    : [];
  return {
    planId: plan.id,
    planStatus: plan.status,
    firstOpenPhase: firstOpen ?? null,
    tasks,
  };
}

function extractPlanId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.planId === "string" && UUID_RE.test(obj.planId)) {
    return obj.planId;
  }
  const plan = obj.plan;
  if (plan && typeof plan === "object") {
    const id = (plan as { id?: unknown }).id;
    if (typeof id === "string" && UUID_RE.test(id)) return id;
  }
  return undefined;
}

async function defaultWhy(
  runtime: ReturnType<typeof createToolRuntime>,
  id: string,
): Promise<ToolHandlerResult> {
  for (const route of ["plans", "phases", "tasks"]) {
    try {
      const body = await runtime.fetchJson(runtime.apiUrl(`/${route}/${id}`));
      return { route, id, body };
    } catch {
      // Try the next route.
    }
  }
  return { status: "not_found", id };
}

function sanitizeJson(value: unknown): unknown {
  return sanitize(value, 0);
}

function summarizeJson(value: unknown): unknown {
  const sanitized = sanitize(value, 0);
  const text = JSON.stringify(sanitized);
  if (text.length <= 4000) return sanitized;
  return {
    truncated: true,
    preview: text.slice(0, 4000),
  };
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 5) return "[max-depth]";
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("password") ||
        lower.includes("authorization") ||
        lower.includes("api_key") ||
        lower === "key"
      ) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitize(inner, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function extractRefs(value: unknown): Partial<ToolCallRecord> {
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  const refs: Partial<ToolCallRecord> = {};
  for (const [field, attr] of [
    ["specDocumentId", "specDocumentId"],
    ["repoSnapshotId", "repoSnapshotId"],
    ["planId", "planId"],
    ["phaseId", "phaseId"],
    ["taskId", "taskId"],
  ] as const) {
    if (typeof obj[field] === "string" && UUID_RE.test(obj[field])) {
      refs[attr] = obj[field];
    }
  }
  return refs;
}

function extractOutputRefs(
  toolName: PmGoToolName,
  value: unknown,
): Partial<ToolCallRecord> {
  const refs = extractRefs(value);
  // POST /plans returns planId synchronously, but the row is inserted
  // asynchronously by the persistPlan activity. `pmgo_decompose_spec`
  // now waits for GET /plans/:id before returning `status: ready`; only
  // that ready result is safe to FK-link.
  if (
    toolName === "pmgo_decompose_spec" &&
    (value as { status?: unknown })?.status !== "ready" &&
    "planId" in refs
  ) {
    delete refs.planId;
  }
  return refs;
}
