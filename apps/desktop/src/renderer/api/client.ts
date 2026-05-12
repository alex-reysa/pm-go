import type {
  AgentRole,
  AgentRun,
  AgentToolCall,
  ApprovalRequest,
  BudgetReport,
  CompletionAuditReport,
  MergeRun,
  Phase,
  PhaseAuditReport,
  Plan,
  PolicyDecision,
  ReviewReport,
  Risk,
  Task,
  UUID,
  WorkflowEvent,
  WorktreeLease,
} from "@pm-go/contracts";

import type { Config } from "../../shared/config.js";
import { isPmGoHealthEnvelope, type HealthEnvelope } from "../../shared/health.js";
import { normalizeBaseUrl as normalizeDesktopBaseUrl } from "../../shared/url.js";

export type PlanListItem = Pick<
  Plan,
  "id" | "title" | "summary" | "status" | "createdAt" | "updatedAt"
> & {
  risks: Risk[];
  completionAuditReportId: UUID | null;
};

export type PhaseListItem = Pick<
  Phase,
  "id" | "planId" | "index" | "title" | "summary" | "status" | "integrationBranch"
> & {
  phaseAuditReportId: UUID | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type TaskListItem = Pick<
  Task,
  "id" | "planId" | "phaseId" | "slug" | "title" | "status" | "riskLevel" | "kind"
>;

export type AgentRunListItem = AgentRun;

export type TaskReviewReport = ReviewReport & {
  cycleNumber: number;
};

export type PhaseDetailPhase = Pick<
  Phase,
  | "id"
  | "planId"
  | "index"
  | "title"
  | "summary"
  | "status"
  | "integrationBranch"
  | "baseSnapshotId"
  | "taskIds"
  | "mergeOrder"
> & {
  phaseAuditReportId: UUID | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PhaseDetailMergeRun = Pick<
  MergeRun,
  | "id"
  | "planId"
  | "phaseId"
  | "integrationBranch"
  | "baseSha"
  | "mergedTaskIds"
  | "startedAt"
> & {
  failedTaskId: UUID | null;
  integrationHeadSha: string | null;
  postMergeSnapshotId: UUID | null;
  integrationLeaseId: UUID | null;
  completedAt: string | null;
};

export type PhaseDetailAudit = PhaseAuditReport & {
  overrideReason?: string;
  overriddenBy?: string;
  overriddenAt?: string;
};

export interface PhaseDetail {
  phase: PhaseDetailPhase;
  latestMergeRun: PhaseDetailMergeRun | null;
  latestPhaseAudit: PhaseDetailAudit | null;
}

export interface PlanDetail {
  plan: Plan;
  artifactIds: UUID[];
  latestCompletionAudit: CompletionAuditReport | null;
}

export interface TaskDetail {
  task: Task;
  latestAgentRun: AgentRun | null;
  latestLease: WorktreeLease | null;
  latestReviewReport: ReviewReport | null;
  taskPolicyDecisions: PolicyDecision[];
  reviewSkippedDecision?: PolicyDecision;
}

export interface ReplayedEvents {
  events: WorkflowEvent[];
  lastEventId: UUID | null;
}

export interface TaskWorkflowMutationResult {
  taskId: UUID;
  workflowRunId: string;
  cycleNumber: number;
  reviewReportId?: UUID;
}

export interface PhaseWorkflowMutationResult {
  phaseId: UUID;
  workflowRunId: string;
  mergeRunIndex?: number;
  auditIndex?: number;
}

export interface PlanWorkflowMutationResult {
  planId: UUID;
  workflowRunId: string;
  auditIndex?: number;
  releaseIndex?: number;
}

export interface TaskApprovalMutationResult {
  taskId: UUID;
  approval: ApprovalRequest;
}

export interface PlanApprovalMutationResult {
  planId: UUID;
  approval: ApprovalRequest;
}

export interface OverrideReviewMutationResult {
  taskId: UUID;
  previousStatus: string;
  newStatus: string;
  policyDecisionId: UUID;
  overriddenBy?: string;
  reason: string;
}

export interface OverrideAuditMutationResult {
  phaseId: UUID;
  previousStatus: string;
  newStatus: string;
  auditReportId: UUID;
  reason: string;
  overriddenBy?: string;
  overriddenAt: string;
  nextPhaseId?: UUID;
  nextPhaseStatus?: string;
}

export interface ApproveAllPendingResult {
  planId: UUID;
  approvedCount: number;
  approvedIds: UUID[];
  skippedCount: number;
  skipped: Array<{
    id: UUID;
    taskId: UUID | null;
    reason: string;
  }>;
}

export type ArtifactRead =
  | {
      artifactId: UUID;
      bodyKind: "json";
      contentType: string;
      contentLength: number | null;
      text: string;
      json: unknown;
    }
  | {
      artifactId: UUID;
      bodyKind: "text";
      contentType: string;
      contentLength: number | null;
      text: string;
    }
  | {
      artifactId: UUID;
      bodyKind: "binary";
      contentType: string;
      contentLength: number | null;
      bytes: ArrayBuffer;
    };

export type ApiHealthProbeResult =
  | { kind: "connected"; envelope: HealthEnvelope }
  | { kind: "api_unreachable"; message?: string }
  | { kind: "foreign_service"; status?: number }
  | { kind: "api_error"; status?: number; body?: unknown; requestId?: string };

export interface DesktopApiClient {
  readonly baseUrl: string;
  probeHealth(): Promise<ApiHealthProbeResult>;
  listPlans(): Promise<PlanListItem[]>;
  getPlan(planId: UUID): Promise<PlanDetail>;
  listPhases(planId: UUID): Promise<PhaseListItem[]>;
  getPhase(phaseId: UUID): Promise<PhaseDetail>;
  listTasks(scope: { phaseId: UUID } | { planId: UUID }): Promise<TaskListItem[]>;
  getTask(taskId: UUID): Promise<TaskDetail>;
  listTaskReviewReports(taskId: UUID): Promise<TaskReviewReport[]>;
  listAgentRuns(
    scope: { taskId: UUID } | { planId: UUID; role?: AgentRole },
  ): Promise<AgentRunListItem[]>;
  listAgentRunToolCalls(runId: UUID): Promise<AgentToolCall[]>;
  listApprovals(planId: UUID): Promise<ApprovalRequest[]>;
  getBudgetReport(planId: UUID): Promise<BudgetReport>;
  replayEvents(planId: UUID, sinceEventId?: UUID): Promise<ReplayedEvents>;
  createEventStreamUrl(planId: UUID, sinceEventId?: UUID): string;
  readArtifact(artifactId: UUID): Promise<ArtifactRead>;
  runTask(taskId: UUID, input?: { requestedBy?: string }): Promise<TaskWorkflowMutationResult>;
  reviewTask(taskId: UUID): Promise<TaskWorkflowMutationResult>;
  fixTask(taskId: UUID): Promise<TaskWorkflowMutationResult>;
  approveTask(taskId: UUID, input?: { approvedBy?: string }): Promise<TaskApprovalMutationResult>;
  overrideReview(
    taskId: UUID,
    input: { reason: string; overriddenBy?: string },
  ): Promise<OverrideReviewMutationResult>;
  integratePhase(phaseId: UUID): Promise<PhaseWorkflowMutationResult>;
  auditPhase(phaseId: UUID): Promise<PhaseWorkflowMutationResult>;
  overrideAudit(
    phaseId: UUID,
    input: { reason: string; overriddenBy?: string },
  ): Promise<OverrideAuditMutationResult>;
  approvePlan(planId: UUID, input?: { approvedBy?: string }): Promise<PlanApprovalMutationResult>;
  approveAllPending(
    planId: UUID,
    input: { reason: string; approvedBy?: string },
  ): Promise<ApproveAllPendingResult>;
  completePlan(planId: UUID, input?: { requestedBy?: string }): Promise<PlanWorkflowMutationResult>;
  releasePlan(planId: UUID): Promise<PlanWorkflowMutationResult>;
}

export interface CreateDesktopApiClientOptions {
  baseUrl: string;
  request?: typeof globalThis.fetch;
}

export interface CreateDesktopApiClientFromConfigOptions {
  request?: typeof globalThis.fetch;
}

export class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigurationError";
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly recoverable: boolean;
  readonly requestId?: string;

  constructor(
    status: number,
    body: unknown,
    message?: string,
    requestId?: string,
  ) {
    super(message ?? extractErrorMessage(body) ?? fallbackMessageForStatus(status));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.recoverable = isRecoverableApiStatus(status);
    if (requestId !== undefined) {
      this.requestId = requestId;
    }
  }
}

export function isRecoverableApiStatus(status: number): boolean {
  return status === 403 || status === 404 || status === 409 || status >= 500;
}

export function normalizeApiBaseUrl(input: string): string {
  const normalized = normalizeDesktopBaseUrl(input);
  if (normalized === "") return "";

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new ApiConfigurationError("API base URL must be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiConfigurationError("API base URL must use http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ApiConfigurationError("API base URL must not include credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ApiConfigurationError("API base URL must not include query or fragment parts.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path === "" ? "/" : path;
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

export function createDesktopApiClientFromConfig(
  config: Pick<Config, "apiBaseUrl">,
  options: CreateDesktopApiClientFromConfigOptions = {},
): DesktopApiClient {
  return createDesktopApiClient({
    baseUrl: config.apiBaseUrl,
    ...(options.request !== undefined ? { request: options.request } : {}),
  });
}

export function createDesktopApiClient(
  options: CreateDesktopApiClientOptions,
): DesktopApiClient {
  const baseUrl = normalizeApiBaseUrl(options.baseUrl);
  const request = options.request ?? globalThis.fetch.bind(globalThis);

  function url(
    segments: readonly string[],
    query?: Readonly<Record<string, string | undefined>>,
  ): string {
    return buildApiUrl(baseUrl, segments, query);
  }

  async function send(
    segments: readonly string[],
    init: RequestInit = {},
    query?: Readonly<Record<string, string | undefined>>,
  ): Promise<Response> {
    const target = url(segments, query);
    try {
      return await request(target, init);
    } catch (err) {
      throw new ApiError(0, networkErrorBody(err), "Unable to reach the pm-go API.");
    }
  }

  async function getJson<T>(
    segments: readonly string[],
    query?: Readonly<Record<string, string | undefined>>,
  ): Promise<T> {
    const res = await send(
      segments,
      { headers: { accept: "application/json" } },
      query,
    );
    const body = await parseJsonSafe(res);
    if (!res.ok) throw apiErrorFromResponse(res, body);
    return body as T;
  }

  async function postJson<T>(
    segments: readonly string[],
    body?: Record<string, unknown>,
  ): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      headers: body === undefined
        ? { accept: "application/json" }
        : {
            accept: "application/json",
            "content-type": "application/json",
          },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const res = await send(segments, init);
    const parsed = await parseJsonSafe(res);
    if (!res.ok) throw apiErrorFromResponse(res, parsed);
    return parsed as T;
  }

  return {
    baseUrl,
    async probeHealth() {
      let res: Response;
      try {
        res = await request(url(["health"]), {
          headers: { accept: "application/json" },
        });
      } catch (err) {
        const message = messageFromUnknown(err);
        return {
          kind: "api_unreachable",
          ...(message !== undefined ? { message } : {}),
        };
      }

      const body = await parseJsonSafe(res);
      if (!res.ok) {
        const requestId = extractRequestId(res.headers, body);
        return {
          kind: "api_error",
          status: res.status,
          body,
          ...(requestId !== undefined ? { requestId } : {}),
        };
      }
      if (isPmGoHealthEnvelope(body)) {
        return { kind: "connected", envelope: body };
      }
      return { kind: "foreign_service", status: res.status };
    },
    async listPlans() {
      const body = await getJson<{ plans: PlanListItem[] }>(["plans"]);
      return body.plans;
    },
    async getPlan(planId) {
      return getJson<PlanDetail>(["plans", planId]);
    },
    async listPhases(planId) {
      const body = await getJson<{ planId: UUID; phases: PhaseListItem[] }>(
        ["phases"],
        { planId },
      );
      return body.phases;
    },
    async getPhase(phaseId) {
      return getJson<PhaseDetail>(["phases", phaseId]);
    },
    async listTasks(scope) {
      const query =
        "phaseId" in scope
          ? { phaseId: scope.phaseId }
          : { planId: scope.planId };
      const body = await getJson<{ tasks: TaskListItem[] }>(["tasks"], query);
      return body.tasks;
    },
    async getTask(taskId) {
      return getJson<TaskDetail>(["tasks", taskId]);
    },
    async listTaskReviewReports(taskId) {
      const body = await getJson<{ taskId: UUID; reports: TaskReviewReport[] }>([
        "tasks",
        taskId,
        "review-reports",
      ]);
      return body.reports;
    },
    async listAgentRuns(scope) {
      const query =
        "taskId" in scope
          ? { taskId: scope.taskId }
          : { planId: scope.planId, role: scope.role };
      const body = await getJson<{
        taskId?: UUID;
        planId?: UUID;
        agentRuns: AgentRunListItem[];
      }>(["agent-runs"], query);
      return body.agentRuns;
    },
    async listAgentRunToolCalls(runId) {
      const body = await getJson<{ agentRunId: UUID; toolCalls: AgentToolCall[] }>([
        "agent-runs",
        runId,
        "tool-calls",
      ]);
      return body.toolCalls;
    },
    async listApprovals(planId) {
      const body = await getJson<{ planId: UUID; approvals: ApprovalRequest[] }>(
        ["approvals"],
        { planId },
      );
      return body.approvals;
    },
    async getBudgetReport(planId) {
      return getJson<BudgetReport>(["plans", planId, "budget-report"]);
    },
    async replayEvents(planId, sinceEventId) {
      const body = await getJson<{
        planId: UUID;
        events: WorkflowEvent[];
        lastEventId: UUID | null;
      }>(["events"], { planId, sinceEventId });
      return { events: body.events, lastEventId: body.lastEventId };
    },
    createEventStreamUrl(planId, sinceEventId) {
      return url(["events"], { planId, sinceEventId });
    },
    async readArtifact(artifactId) {
      const res = await send(["artifacts", artifactId], {
        headers: {
          accept: "application/json, text/markdown, text/plain, application/octet-stream",
        },
      });
      if (!res.ok) {
        const body = await parseJsonSafe(res);
        throw apiErrorFromResponse(res, body);
      }
      return parseArtifactResponse(artifactId, res);
    },
    async runTask(taskId, input) {
      return postJson<TaskWorkflowMutationResult>(["tasks", taskId, "run"], input);
    },
    async reviewTask(taskId) {
      return postJson<TaskWorkflowMutationResult>(["tasks", taskId, "review"]);
    },
    async fixTask(taskId) {
      return postJson<TaskWorkflowMutationResult>(["tasks", taskId, "fix"]);
    },
    async approveTask(taskId, input) {
      return postJson<TaskApprovalMutationResult>(["tasks", taskId, "approve"], input);
    },
    async overrideReview(taskId, input) {
      return postJson<OverrideReviewMutationResult>([
        "tasks",
        taskId,
        "override-review",
      ], input);
    },
    async integratePhase(phaseId) {
      return postJson<PhaseWorkflowMutationResult>(["phases", phaseId, "integrate"]);
    },
    async auditPhase(phaseId) {
      return postJson<PhaseWorkflowMutationResult>(["phases", phaseId, "audit"]);
    },
    async overrideAudit(phaseId, input) {
      return postJson<OverrideAuditMutationResult>([
        "phases",
        phaseId,
        "override-audit",
      ], input);
    },
    async approvePlan(planId, input) {
      return postJson<PlanApprovalMutationResult>(["plans", planId, "approve"], input);
    },
    async approveAllPending(planId, input) {
      return postJson<ApproveAllPendingResult>([
        "plans",
        planId,
        "approve-all-pending",
      ], input);
    },
    async completePlan(planId, input) {
      return postJson<PlanWorkflowMutationResult>(["plans", planId, "complete"], input);
    },
    async releasePlan(planId) {
      return postJson<PlanWorkflowMutationResult>(["plans", planId, "release"]);
    },
  };
}

export function buildApiUrl(
  baseUrl: string,
  segments: readonly string[],
  query?: Readonly<Record<string, string | undefined>>,
): string {
  const normalized = normalizeApiBaseUrl(baseUrl);
  if (normalized === "") {
    throw new ApiConfigurationError("API base URL is not configured.");
  }

  const url = new URL(normalized);
  const basePath = url.pathname.replace(/\/+$/, "");
  const endpointPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  url.pathname = [basePath, endpointPath].filter((part) => part !== "").join("/");

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, value);
  }
  url.search = params.toString();
  return url.toString();
}

async function parseArtifactResponse(
  artifactId: UUID,
  res: Response,
): Promise<ArtifactRead> {
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const contentLength = parseContentLength(res.headers.get("content-length"));
  if (isJsonContentType(contentType)) {
    const text = await res.text();
    return {
      artifactId,
      bodyKind: "json",
      contentType,
      contentLength,
      text,
      json: parseJsonText(text),
    };
  }
  if (isTextContentType(contentType)) {
    return {
      artifactId,
      bodyKind: "text",
      contentType,
      contentLength,
      text: await res.text(),
    };
  }
  return {
    artifactId,
    bodyKind: "binary",
    contentType,
    contentLength,
    bytes: await res.arrayBuffer(),
  };
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  return parseJsonText(text);
}

function parseJsonText(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function apiErrorFromResponse(res: Response, body: unknown): ApiError {
  return new ApiError(
    res.status,
    body,
    undefined,
    extractRequestId(res.headers, body),
  );
}

function extractRequestId(headers: Headers, body: unknown): string | undefined {
  const headerValue =
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("x-correlation-id");
  if (headerValue !== null && headerValue.trim() !== "") return headerValue;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["requestId", "request_id", "traceId"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return undefined;
}

function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim() !== "") return body;
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function fallbackMessageForStatus(status: number): string {
  if (status === 0) return "Unable to reach the pm-go API.";
  if (status === 403) return "The API refused access to this resource.";
  if (status === 404) return "The requested API resource was not found.";
  if (status === 409) return "The request conflicts with the current API state.";
  if (status >= 500) return "The API returned a server error.";
  return `HTTP ${status}`;
}

function networkErrorBody(err: unknown): { error: string; cause?: string } {
  const cause = messageFromUnknown(err);
  return {
    error: "network_error",
    ...(cause !== undefined ? { cause } : {}),
  };
}

function messageFromUnknown(value: unknown): string | undefined {
  if (value instanceof Error && value.message.trim() !== "") return value.message;
  if (typeof value === "string" && value.trim() !== "") return value;
  return undefined;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function contentTypeToken(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isJsonContentType(contentType: string): boolean {
  const token = contentTypeToken(contentType);
  return token === "application/json" || token.endsWith("+json");
}

function isTextContentType(contentType: string): boolean {
  return contentTypeToken(contentType).startsWith("text/");
}
