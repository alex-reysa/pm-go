// pm-go mock data ------------------------------------------------------
window.PMGO_DATA = (() => {
  const now = Date.now();
  const ago = (m) => new Date(now - m * 60_000).toISOString();

  const repos = [
    { id: "repo-frame", path: "github.com/acme/frame-platform", branch: "main", sha: "a91f2c7" },
    { id: "repo-billing", path: "github.com/acme/billing-engine", branch: "main", sha: "7d22ae0" },
    { id: "repo-ui", path: "github.com/acme/ui-kit", branch: "main", sha: "3b1a004" },
  ];

  const runs = [
    {
      id: "run-7421",
      title: "Migrate billing service to event-sourced ledger",
      repo: "acme/billing-engine",
      status: "running",
      phase: "Implementation · Phase 2 of 4",
      progress: { done: 7, total: 12 },
      blocker: null,
      updated: ago(2),
      runtime: "claude",
      owner: "JE",
    },
    {
      id: "run-7418",
      title: "Replace legacy auth middleware with JWT verifier",
      repo: "acme/frame-platform",
      status: "blocked",
      phase: "Review · Phase 1 of 3",
      progress: { done: 4, total: 9 },
      blocker: "Awaiting human approval: Override Review (1)",
      updated: ago(11),
      runtime: "sdk",
      owner: "JE",
    },
    {
      id: "run-7405",
      title: "Add multi-tenant pricing rules to checkout API",
      repo: "acme/billing-engine",
      status: "in_review",
      phase: "Review · Phase 3 of 3",
      progress: { done: 11, total: 12 },
      blocker: "2 findings · medium severity",
      updated: ago(48),
      runtime: "claude",
      owner: "MR",
    },
    {
      id: "run-7392",
      title: "Refactor design tokens to CSS custom properties",
      repo: "acme/ui-kit",
      status: "ready_to_merge",
      phase: "Audit · Completion",
      progress: { done: 8, total: 8 },
      blocker: null,
      updated: ago(82),
      runtime: "stub",
      owner: "JE",
    },
    {
      id: "run-7388",
      title: "Generate end-to-end test suite from feature specs",
      repo: "acme/frame-platform",
      status: "failed",
      phase: "Implementation · Phase 1 of 5",
      progress: { done: 1, total: 18 },
      blocker: "Runtime error: budget exhausted",
      updated: ago(180),
      runtime: "claude",
      owner: "MR",
    },
    {
      id: "run-7344",
      title: "Add structured logging to ingest pipeline",
      repo: "acme/frame-platform",
      status: "released",
      phase: "Released",
      progress: { done: 6, total: 6 },
      blocker: null,
      updated: ago(60 * 18),
      runtime: "claude",
      owner: "JE",
      release: { version: "v2.18.0", at: ago(60 * 17) },
    },
    {
      id: "run-7301",
      title: "Compliance audit logging across services",
      repo: "acme/billing-engine",
      status: "released",
      phase: "Released",
      progress: { done: 14, total: 14 },
      blocker: null,
      updated: ago(60 * 42),
      runtime: "claude",
      owner: "MR",
      release: { version: "v3.04.1", at: ago(60 * 41) },
    },
  ];

  const phases = [
    {
      id: "p-spec", title: "Spec & Plan", status: "done",
      summary: "Decomposed into 4 phases · 12 tasks · 24 acceptance criteria"
    },
    {
      id: "p-1", title: "Phase 1 · Schema migrations", status: "done",
      summary: "3 tasks · merged · audit passed"
    },
    {
      id: "p-2", title: "Phase 2 · Ledger write path", status: "active",
      summary: "5 tasks · 2 in review · 1 fixing"
    },
    {
      id: "p-3", title: "Phase 3 · Read API and reconciliation", status: "queued",
      summary: "3 tasks pending"
    },
    {
      id: "p-4", title: "Phase 4 · Cutover & shadow run", status: "queued",
      summary: "1 task pending"
    },
    {
      id: "p-int", title: "Phase Integration", status: "queued", summary: "" },
    {
      id: "p-aud", title: "Completion Audit", status: "queued", summary: "" },
    {
      id: "p-rel", title: "Release", status: "queued", summary: "" },
  ];

  const tasks = [
    { id: "T-001", title: "Append-only ledger table migration", phase: "Phase 1", status: "merged", risk: "low",  scope: "db/migrations/0021…", branch: "feat/ledger-table", review: "approved", budget: 0.42 },
    { id: "T-002", title: "Backfill historical balances",       phase: "Phase 1", status: "merged", risk: "med",  scope: "scripts/backfill_*.py", branch: "feat/backfill", review: "approved", budget: 0.81 },
    { id: "T-003", title: "Idempotency keys on write path",     phase: "Phase 1", status: "merged", risk: "low",  scope: "billing/ledger/keys.py", branch: "feat/idem-keys", review: "approved", budget: 0.36 },
    { id: "T-004", title: "Double-entry posting rules",         phase: "Phase 2", status: "running", risk: "high", scope: "billing/ledger/posting/*", branch: "feat/posting", review: "—", budget: 0.62 },
    { id: "T-005", title: "Refund flow with reversing entries", phase: "Phase 2", status: "in_review", risk: "high", scope: "billing/refunds/*", branch: "feat/refunds", review: "2 findings", budget: 0.78 },
    { id: "T-006", title: "Reconciliation job (daily)",         phase: "Phase 2", status: "fixing", risk: "med", scope: "jobs/reconcile.py", branch: "feat/reconcile", review: "changes requested", budget: 0.55 },
    { id: "T-007", title: "Webhook fan-out for ledger events",  phase: "Phase 2", status: "ready", risk: "low", scope: "billing/events/webhooks.py", branch: "feat/webhooks", review: "—", budget: 0.0 },
    { id: "T-008", title: "Posting metrics & SLO alerts",       phase: "Phase 2", status: "ready", risk: "low", scope: "ops/alerts/posting.yaml", branch: "feat/alerts", review: "—", budget: 0.0 },
    { id: "T-009", title: "Read API: balance endpoints",        phase: "Phase 3", status: "ready", risk: "med", scope: "billing/api/balance.py", branch: "—", review: "—", budget: 0.0 },
    { id: "T-010", title: "Read API: transaction history",      phase: "Phase 3", status: "ready", risk: "med", scope: "billing/api/history.py", branch: "—", review: "—", budget: 0.0 },
    { id: "T-011", title: "Reconciliation report exporter",     phase: "Phase 3", status: "ready", risk: "low", scope: "billing/reports/*", branch: "—", review: "—", budget: 0.0 },
    { id: "T-012", title: "Dual-write shadow cutover",          phase: "Phase 4", status: "ready", risk: "high", scope: "billing/cutover/*", branch: "—", review: "—", budget: 0.0 },
  ];

  const findings = [
    { id: "F-31", severity: "high", file: "billing/refunds/reverse.py", lines: "82–104", summary: "Reversal does not use the same idempotency key family as the original posting; replays may double-credit.", confidence: "high", suggestion: "Inherit `idem_root` from the original posting; salt with `reversal:` and persist before the write transaction.", status: "open", task: "T-005" },
    { id: "F-30", severity: "med", file: "billing/refunds/reverse.py", lines: "44–58", summary: "Negative amount paths bypass the validation pipeline used by forward postings.", confidence: "med", suggestion: "Route reversals through `posting.validate(...)` and reuse the existing rule set.", status: "open", task: "T-005" },
    { id: "F-28", severity: "low", file: "jobs/reconcile.py", lines: "210–215", summary: "Log line uses f-string interpolation of user-provided account label.", confidence: "low", suggestion: "Use structured logger fields rather than embedding the label into the message body.", status: "fixed", task: "T-006" },
  ];

  const approvals = [
    { id: "A-114", subject: "Override review for refund reversal logic", reason: "Author requests waiver: edge case is covered by separate test, severity downgraded.", risk: "high", run: "run-7418", task: "T-005", created: ago(28), recommend: "review" },
    { id: "A-112", subject: "Approve plan: ledger migration",            reason: "Plan creation gate — review proposed phases before implementation.", risk: "med", run: "run-7421", task: null, created: ago(120), recommend: "approve" },
    { id: "A-110", subject: "Budget gate: Phase 2 above estimate",       reason: "Phase 2 has consumed 78% of estimated budget; remaining tasks projected at +14%.", risk: "med", run: "run-7421", task: null, created: ago(90), recommend: "approve" },
    { id: "A-108", subject: "Release approval: ui-kit v4.2.0",           reason: "Completion audit passed. Ready for release.", risk: "low", run: "run-7392", task: null, created: ago(40), recommend: "approve" },
  ];

  const events = [
    { at: ago(1),  kind: "task",     ref: "T-004", body: "Implementation agent started: double-entry posting rules" },
    { at: ago(3),  kind: "task",     ref: "T-005", body: "Review reported 2 findings (1 high, 1 med)" },
    { at: ago(6),  kind: "review",   ref: "T-006", body: "Review requested changes: reconciliation log formatting" },
    { at: ago(9),  kind: "task",     ref: "T-006", body: "Fix loop iteration 2 started" },
    { at: ago(14), kind: "audit",    ref: "Phase 1", body: "Phase audit passed (8 of 8 acceptance criteria)" },
    { at: ago(22), kind: "approval", ref: "A-114", body: "Approval requested: override review for T-005" },
    { at: ago(33), kind: "artifact", ref: "review-007.md", body: "Review report written for T-005" },
    { at: ago(48), kind: "error",    ref: "T-004", body: "Test failure: posting_test.py::test_double_entry_balance" },
    { at: ago(74), kind: "task",     ref: "T-007", body: "Marked ready" },
    { at: ago(95), kind: "task",     ref: "T-008", body: "Marked ready" },
    { at: ago(120),kind: "approval", ref: "A-112", body: "Plan approved by Jordan E." },
  ];

  const artifacts = [
    { id: "art-2042", kind: "completion-audit", name: "completion-audit-billing-v3.md", run: "run-7301", size: "14.8 KB", at: ago(60*42), tag: "passed" },
    { id: "art-2041", kind: "pr-summary",       name: "pr-summary-7301.md",            run: "run-7301", size: "2.1 KB",  at: ago(60*42), tag: "merged" },
    { id: "art-2038", kind: "evidence",         name: "evidence-bundle-7301.tar",      run: "run-7301", size: "212 MB",  at: ago(60*42), tag: "" },
    { id: "art-2030", kind: "review",           name: "review-T-005.md",               run: "run-7405", size: "8.4 KB",  at: ago(60*4),  tag: "2 findings" },
    { id: "art-2027", kind: "test",             name: "test-report-phase-2.json",      run: "run-7421", size: "84 KB",   at: ago(60*5),  tag: "1 fail" },
    { id: "art-2024", kind: "patch",            name: "patch-T-004.diff",              run: "run-7421", size: "11 KB",   at: ago(60*6),  tag: "" },
    { id: "art-2018", kind: "plan",             name: "plan-billing-ledger.md",        run: "run-7421", size: "6.2 KB",  at: ago(60*48), tag: "approved" },
  ];

  const stack = {
    overall: "healthy",
    runtime: "claude · sonnet 4.5",
    runtimeStatus: "healthy",
    runtimeLatency: 412,
    sandbox: { status: "healthy", queue: 2, capacity: 8 },
    git:     { status: "healthy", remote: "github" },
    review:  { status: "healthy", model: "claude · sonnet 4.5" },
    budget:  { status: "warn", spent: 18.40, ceiling: 25.00 },
    history: [1,1,1,1,1,1,2,1,1,1,1,1,1,1,1,1,1,1,1,1,2,1,1,1], // 1=on, 2=warn, 3=fail
  };

  const repoIntel = {
    branch: "main",
    sha: "7d22ae0",
    languages: ["Python 3.11", "TypeScript", "SQL"],
    frameworks: ["FastAPI", "SQLAlchemy", "Alembic", "pytest"],
    build: ["make build", "uv pip install -r requirements.txt"],
    test:  ["make test", "pytest -q"],
    ci:    [".github/workflows/ci.yml", ".github/workflows/release.yml", "Makefile"],
  };

  const workflowTemplate = {
    nodes: [
      { id: "n1",  kind: "spec",         name: "Spec",                  x: 40,  y: 32,  tone: "neutral" },
      { id: "n2",  kind: "snapshot",     name: "Repo Snapshot",         x: 40,  y: 110, tone: "neutral" },
      { id: "n3",  kind: "decompose",    name: "Spec Decomposition",    x: 240, y: 70,  tone: "violet" },
      { id: "n4",  kind: "plan",         name: "Plan Creation",         x: 440, y: 70,  tone: "violet" },
      { id: "n5",  kind: "approval",     name: "Plan Review Gate",      x: 640, y: 70,  tone: "warn" },
      { id: "n6",  kind: "partition",    name: "Phase Partition",       x: 840, y: 70,  tone: "neutral" },
      { id: "n7",  kind: "parallel",     name: "Parallel Tasks",        x: 1040, y: 70, tone: "cobalt" },
      { id: "n8",  kind: "implement",    name: "Implement Task",        x: 1040, y: 160, tone: "cobalt" },
      { id: "n9",  kind: "review",       name: "Review Task",           x: 1040, y: 240, tone: "violet" },
      { id: "n10", kind: "fix",          name: "Fix Loop",              x: 870, y: 280, tone: "warn" },
      { id: "n11", kind: "budget",       name: "Budget Gate",           x: 700, y: 240, tone: "warn" },
      { id: "n12", kind: "integration",  name: "Phase Integration",     x: 700, y: 340, tone: "neutral" },
      { id: "n13", kind: "audit-phase",  name: "Phase Audit",           x: 500, y: 340, tone: "neutral" },
      { id: "n14", kind: "audit-final",  name: "Completion Audit",      x: 300, y: 340, tone: "success" },
      { id: "n15", kind: "approval",     name: "Human Approval",        x: 100, y: 340, tone: "warn" },
      { id: "n16", kind: "release",      name: "Release",               x: 100, y: 430, tone: "success" },
      { id: "n17", kind: "artifact",     name: "Artifact",              x: 320, y: 430, tone: "neutral" },
    ],
    edges: [
      ["n1","n3"], ["n2","n3"], ["n3","n4"], ["n4","n5"], ["n5","n6"], ["n6","n7"],
      ["n7","n8"], ["n8","n9"], ["n9","n10"], ["n10","n8"], ["n9","n11"], ["n11","n12"],
      ["n12","n13"], ["n13","n14"], ["n14","n15"], ["n15","n16"], ["n16","n17"],
    ],
  };

  return { repos, runs, phases, tasks, findings, approvals, events, artifacts, stack, repoIntel, workflowTemplate };
})();
