import type {
  AgentRun,
  ApprovalRequest,
  BudgetReport,
  CompletionAuditReport,
  Phase,
  Plan,
  Risk,
  Task,
  UUID,
  WorkflowEvent,
} from "@pm-go/contracts";

/**
 * Shapes returned by the Phase 6 list/read endpoints. The server
 * emits summary projections (not the full `Plan`/`Phase`/`Task` —
 * the dashboard doesn't need dependency graphs or test commands for a
 * list view). Keeping these as `Pick<>`s of the domain types means a
 * contract change flows here as a compile error instead of a silent
 * drift.
 */
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

export type AgentRunListItem = Omit<AgentRun, "events">;

export interface PlanDetail {
  plan: Plan;
  artifactIds: UUID[];
  /**
   * The most recent `completion_audit_reports` row for this plan, or
   * null if `/plans/:id/complete` hasn't run. The shape mirrors the
   * contract's `CompletionAuditReport` (id, outcome, summary, etc.)
   * so release-screen code can render findings + checklist without
   * re-fetching.
   */
  latestCompletionAudit: CompletionAuditReport | null;
}

export interface ReplayedEvents {
  events: WorkflowEvent[];
  lastEventId: UUID | null;
}

/**
 * Thrown whenever the API returns a non-2xx status. Preserves the
 * status code + parsed body so UI code can branch on 409 (precondition
 * violation) vs 404 (stale id in a cached query) vs 5xx (surface as
 * a toast).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? extractErrorMessage(body) ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.name = "ApiError";
  }
}

function extractErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string") return err;
  }
  return undefined;
}

export interface ApiClient {
  listPlans(): Promise<PlanListItem[]>;
  getPlan(planId: UUID): Promise<PlanDetail>;
  listPhases(planId: UUID): Promise<PhaseListItem[]>;
  listTasks(
    scope: { phaseId: UUID } | { planId: UUID },
  ): Promise<TaskListItem[]>;
  listAgentRuns(taskId: UUID): Promise<AgentRunListItem[]>;
  replayEvents(
    planId: UUID,
    sinceEventId?: UUID,
  ): Promise<ReplayedEvents>;
  /**
   * Returns the raw `fetch` Response so callers can stream or read the
   * body as text/bytes. Server side already realpath-checks the path
   * against `PLAN_ARTIFACT_DIR`.
   */
  fetchArtifact(artifactId: UUID): Promise<Response>;

  // Write endpoints (Worker 3 binds these to keybinds with confirm modals)
  runTask(taskId: UUID): Promise<void>;
  reviewTask(taskId: UUID): Promise<void>;
  fixTask(taskId: UUID): Promise<void>;
  integratePhase(phaseId: UUID): Promise<void>;
  auditPhase(phaseId: UUID): Promise<void>;
  completePlan(planId: UUID): Promise<void>;
  releasePlan(planId: UUID): Promise<void>;
  // Phase 7 — approval ledger + budget snapshots.
  listApprovals(planId: UUID): Promise<ApprovalRequest[]>;
  approveTask(taskId: UUID): Promise<void>;
  approvePlan(planId: UUID): Promise<void>;
  getBudgetReport(planId: UUID): Promise<BudgetReport>;
}

export interface CreateApiClientOptions {
  baseUrl: string;
  /** Overridable for tests (msw doesn't replace globals in every runtime). */
  fetchImpl?: typeof fetch;
}

export function createApiClient(opts: CreateApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      headers: { accept: "application/json" },
    });
    const body = await parseJsonSafe(res);
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  async function postEmpty(path: string): Promise<void> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      const body = await parseJsonSafe(res);
      throw new ApiError(res.status, body);
    }
  }

  return {
    async listPlans() {
      const body = await getJson<{ plans: PlanListItem[] }>("/plans");
      return body.plans;
    },
    async getPlan(planId) {
      return getJson<PlanDetail>(`/plans/${planId}`);
    },
    async listPhases(planId) {
      const body = await getJson<{ planId: UUID; phases: PhaseListItem[] }>(
        `/phases?planId=${encodeURIComponent(planId)}`,
      );
      return body.phases;
    },
    async listTasks(scope) {
      const qs =
        "phaseId" in scope
          ? `phaseId=${encodeURIComponent(scope.phaseId)}`
          : `planId=${encodeURIComponent(scope.planId)}`;
      const body = await getJson<{ tasks: TaskListItem[] }>(`/tasks?${qs}`);
      return body.tasks;
    },
    async listAgentRuns(taskId) {
      const body = await getJson<{
        taskId: UUID;
        agentRuns: AgentRunListItem[];
      }>(`/agent-runs?taskId=${encodeURIComponent(taskId)}`);
      return body.agentRuns;
    },
    async replayEvents(planId, sinceEventId) {
      const params = new URLSearchParams({ planId });
      if (sinceEventId !== undefined) {
        params.set("sinceEventId", sinceEventId);
      }
      const body = await getJson<{
        planId: UUID;
        events: WorkflowEvent[];
        lastEventId: UUID | null;
      }>(`/events?${params.toString()}`);
      return { events: body.events, lastEventId: body.lastEventId };
    },
    async fetchArtifact(artifactId) {
      const res = await fetchImpl(`${baseUrl}/artifacts/${artifactId}`);
      if (!res.ok) {
        const body = await parseJsonSafe(res);
        throw new ApiError(res.status, body);
      }
      return res;
    },
    runTask: (id) => postEmpty(`/tasks/${id}/run`),
    reviewTask: (id) => postEmpty(`/tasks/${id}/review`),
    fixTask: (id) => postEmpty(`/tasks/${id}/fix`),
    integratePhase: (id) => postEmpty(`/phases/${id}/integrate`),
    auditPhase: (id) => postEmpty(`/phases/${id}/audit`),
    completePlan: (id) => postEmpty(`/plans/${id}/complete`),
    releasePlan: (id) => postEmpty(`/plans/${id}/release`),
    // Phase 7
    async listApprovals(planId) {
      const body = await getJson<{
        planId: UUID;
        approvals: ApprovalRequest[];
      }>(`/approvals?planId=${encodeURIComponent(planId)}`);
      return body.approvals;
    },
    approveTask: (id) => postEmpty(`/tasks/${id}/approve`),
    approvePlan: (id) => postEmpty(`/plans/${id}/approve`),
    async getBudgetReport(planId) {
      return getJson<BudgetReport>(`/plans/${planId}/budget-report`);
    },
  };
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
