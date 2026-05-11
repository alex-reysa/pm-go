/**
 * Fixtures for the collapsed event drawer.
 *
 * Backed conceptually by SSE deliveries from `GET /events?planId=...`
 * and the JSON replay shape from the same endpoint. 05-api-integration.md
 * lists the currently-supported workflow event kinds —
 * `phase_status_changed`, `task_status_changed`,
 * `artifact_persisted` — so the fixture stays within that set; an
 * unknown kind would silently fall through to the drawer's debug
 * log path in M6.
 *
 * Note: SSE wiring lands in M6. M2 is mock-only — the drawer
 * renders the fixture's `data` list inertly.
 */

import type {
  ArtifactKind,
  EventKind,
  EventSeverity,
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
} from "./types.js";

/**
 * `EventItem` is the row shape the collapsed event drawer renders.
 * Tracks 05-api-integration.md § "EventItem".
 *
 * The discriminator is `kind` — `artifact_persisted` carries
 * artifact metadata, the two status-change kinds carry the
 * relevant subject id. `raw` preserves the original payload so
 * a diagnostics view can show the unparsed JSON.
 */
export type EventItem =
  | {
      id: FixtureId;
      planId: FixtureId;
      kind: "phase_status_changed";
      createdAt: IsoTimestamp;
      phaseId: FixtureId;
      taskId: null;
      label: string;
      severity: EventSeverity;
      raw: Record<string, unknown>;
    }
  | {
      id: FixtureId;
      planId: FixtureId;
      kind: "task_status_changed";
      createdAt: IsoTimestamp;
      phaseId: FixtureId;
      taskId: FixtureId;
      label: string;
      severity: EventSeverity;
      raw: Record<string, unknown>;
    }
  | {
      id: FixtureId;
      planId: FixtureId;
      kind: "artifact_persisted";
      createdAt: IsoTimestamp;
      phaseId: FixtureId | null;
      taskId: FixtureId | null;
      artifactId: FixtureId;
      artifactKind: ArtifactKind;
      uri: string;
      label: string;
      severity: EventSeverity;
      raw: Record<string, unknown>;
    };

export type EventsList = EventItem[];

const EVENTS_HAPPY: EventsList = [
  {
    id: "evt_01HVQXB000PHASE000001",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    kind: "phase_status_changed",
    createdAt: "2026-05-10T19:55:01.000Z",
    phaseId: "phase_01HVQX8001FOUNDATION0",
    taskId: null,
    label: "Phase 0 — Foundation: typed fixture module → completed",
    severity: "info",
    raw: { previousStatus: "auditing", newStatus: "completed" },
  },
  {
    id: "evt_01HVQXB001TASK0000001",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    kind: "task_status_changed",
    createdAt: "2026-05-11T08:58:31.000Z",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    taskId: "task_01HVQX9003ROUTES0000",
    label: "Task route-shell → in_review",
    severity: "info",
    raw: { previousStatus: "running", newStatus: "in_review" },
  },
  {
    id: "evt_01HVQXB002ARTIFACT001",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    kind: "artifact_persisted",
    createdAt: "2026-05-11T08:59:14.000Z",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    taskId: "task_01HVQX9003ROUTES0000",
    artifactId: "art_01HVQXA002REVIEWREP00",
    artifactKind: "review_report",
    uri: "artifacts://review_report/01HVQXA002REVIEWREP00",
    label: "Persisted review_report for task route-shell",
    severity: "info",
    raw: {
      artifactId: "art_01HVQXA002REVIEWREP00",
      artifactKind: "review_report",
    },
  },
  {
    id: "evt_01HVQXB003BLOCKED0001",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    kind: "task_status_changed",
    createdAt: "2026-05-10T16:31:00.000Z",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    taskId: "task_01HVQX9004APPROVALS0",
    label: "Task approvals-route → blocked (budget cap)",
    severity: "warn",
    raw: { previousStatus: "running", newStatus: "blocked" },
  },
];

export const eventsHappyPath: FixtureDataset<EventsList> = {
  state: "happy",
  label: "events · 4 events across status + artifact kinds",
  data: EVENTS_HAPPY,
};

export const eventsEmptyState: FixtureDataset<EventsList> = {
  state: "empty",
  label: "events · drawer empty until the first workflow event lands",
  data: [],
};

export const eventsErrorState: FixtureDataset<EventsList> = {
  state: "error",
  label: "events · SSE stream reconnecting after upstream drop",
  data: [],
  error: {
    // Status 0 communicates "renderer-side / network-layer error"
    // — the SSE stream dropped and is in `stream_reconnecting`.
    status: 0,
    message: "SSE stream lost; reconnecting with exponential backoff",
    body: { error: "sse_stream_reconnecting" },
  },
};
