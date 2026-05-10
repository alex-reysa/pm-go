/* global React, Card, IconBezel, Icon, Chip, StatusChip, StatusDot, Button, ProgressBar, rel, STATUS_META, Inspector, FieldRow */
const { useState: useStateRD, useMemo: useMemoRD } = React;

// ---------- Run Detail -------------------------------------------------
const RUN_TABS = [
  { id: "cockpit",  label: "Cockpit" },
  { id: "plan",     label: "Plan" },
  { id: "findings", label: "Findings" },
  { id: "diff",     label: "Diff" },
  { id: "events",   label: "Events" },
  { id: "artifacts",label: "Artifacts" },
];

// Phase + task graph
const Cockpit = ({ data, run, onSelectTask, selectedTaskId }) => {
  const phases = data.phases;
  const tasksByPhase = useMemoRD(() => {
    const map = {};
    data.tasks.forEach(t => { (map[t.phase] = map[t.phase] || []).push(t); });
    return map;
  }, [data.tasks]);

  const PHASE_LABEL = {
    "p-spec": null, "p-1": "Phase 1", "p-2": "Phase 2", "p-3": "Phase 3", "p-4": "Phase 4",
  };

  return (
    <div className="cockpit">
      {phases.map(p => {
        const taskList = tasksByPhase[PHASE_LABEL[p.id]] || [];
        const isActive = p.status === "active";
        const isDone = p.status === "done";
        return (
          <div key={p.id} className={`phase-row${isActive ? " active" : ""}${isDone ? " done" : ""}`}>
            <div className="phase-head">
              <IconBezel
                tone={isDone ? "success" : isActive ? "cobalt" : "neutral"}
                size="md"
                icon={isDone ? "check" : isActive ? "play" : "circle"}
              />
              <span className="phase-title">{p.title}</span>
              {p.summary ? <span className="muted" style={{ fontSize: 12.5 }}>{p.summary}</span> : null}
              {isActive ? <Chip tone="cobalt" dot>Active</Chip> : isDone ? <Chip tone="success" dot>Complete</Chip> : <Chip tone="neutral">Queued</Chip>}
            </div>
            {taskList.length > 0 && (isActive || isDone) ? (
              <div className="phase-tasks">
                {taskList.map(t => {
                  const m = STATUS_META[t.status];
                  return (
                    <div key={t.id}
                        className={`task-pill${selectedTaskId === t.id ? " selected" : ""}`}
                        onClick={() => onSelectTask(t)}>
                      <StatusDot status={t.status} />
                      <span className="title">{t.title}</span>
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{t.id}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

// Plan / spec content as markdown-styled doc
const PlanView = ({ run }) => (
  <Card>
    <div className="col" style={{ gap: 10, fontSize: 13.5, lineHeight: 1.65, color: "var(--ink-2)", maxWidth: 720 }}>
      <h2 className="h2">Migrate billing service to event-sourced ledger</h2>
      <div className="muted">Spec · approved · 2 days ago by Jordan Ellis</div>

      <h3 className="h3" style={{ marginTop: 10 }}>Goal</h3>
      <p style={{ margin: 0 }}>
        Replace the current row-mutating balance table with an append-only ledger model that
        produces strong audit trails for billing operations across all tenants. Maintain wire
        compatibility on existing public balance endpoints.
      </p>
      <h3 className="h3" style={{ marginTop: 10 }}>Phases</h3>
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        <li><strong>Schema migrations.</strong> Add ledger table, indices, idempotency keys.</li>
        <li><strong>Ledger write path.</strong> Double-entry posting, refunds, reconciliation, fan-out.</li>
        <li><strong>Read API & reconciliation.</strong> Balance and history endpoints, exporter.</li>
        <li><strong>Cutover & shadow run.</strong> Dual-write, traffic shift, decommission.</li>
      </ol>
      <h3 className="h3" style={{ marginTop: 10 }}>Acceptance criteria</h3>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>All postings idempotent under retry, validated by replay harness.</li>
        <li>Reconciliation job reports zero discrepancies for 7 consecutive days.</li>
        <li>Read endpoints return identical responses pre/post-cutover in shadow.</li>
        <li>Audit log records every ledger mutation with actor, reason, request ID.</li>
      </ul>
    </div>
  </Card>
);

const SEVERITY_TONE = { high: "rose", med: "warn", low: "neutral" };
const FindingsView = ({ data }) => (
  <Card title={`Open findings · ${data.findings.filter(f => f.status === "open").length}`}
        action={<div className="filterbar"><button className="filter active">All</button><button className="filter">Open</button><button className="filter">Fixed</button></div>}>
    <div className="col" style={{ gap: 8 }}>
      {data.findings.map(f => (
        <div key={f.id} className="row gap-4" style={{ background: "var(--panel-soft)", borderRadius: 12, padding: "12px 14px", alignItems: "stretch", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.85), inset 0 0 0 1px rgba(20,22,20,0.04)" }}>
          <div className={`severity-stripe ${f.severity}`} />
          <div className="col flex1" style={{ gap: 6, minWidth: 0 }}>
            <div className="row gap-3">
              <Chip tone={SEVERITY_TONE[f.severity]} dot>{f.severity === "high" ? "High" : f.severity === "med" ? "Medium" : "Low"}</Chip>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{f.id}</span>
              <span className="muted">·</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{f.file}:{f.lines}</span>
              <span className="muted">·</span>
              <span className="muted" style={{ fontSize: 12 }}>Task {f.task}</span>
              <div className="topbar-spacer" />
              {f.status === "fixed"
                ? <Chip tone="success" dot>Fixed</Chip>
                : <Chip tone="warn" dot>Open</Chip>}
            </div>
            <div style={{ fontSize: 13.5, color: "var(--ink)", fontWeight: 500 }}>{f.summary}</div>
            <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
              <span className="eyebrow" style={{ marginRight: 6 }}>Suggested fix</span>
              {f.suggestion}
            </div>
          </div>
        </div>
      ))}
    </div>
  </Card>
);

const DiffView = () => {
  const lines = [
    { t: "mut", l: "billing/ledger/posting/double_entry.py" },
    { t: "mut", l: "  @@ posting.commit @@" },
    { t: "del", l: "- def commit(entry: Entry) -> Posting:" },
    { t: "del", l: "-     balance = repo.get_balance(entry.account_id)" },
    { t: "del", l: "-     repo.update_balance(entry.account_id, balance + entry.amount)" },
    { t: "del", l: "-     return Posting(id=uuid4(), entry=entry, balance_after=balance + entry.amount)" },
    { t: "add", l: "+ def commit(entry: Entry, *, idem_key: IdemKey) -> Posting:" },
    { t: "add", l: "+     with ledger.txn(idem_key=idem_key) as tx:" },
    { t: "add", l: "+         debit  = tx.append(entry.from_account, -entry.amount, kind=\"debit\")" },
    { t: "add", l: "+         credit = tx.append(entry.to_account,    entry.amount, kind=\"credit\")" },
    { t: "add", l: "+         tx.validate_double_entry(debit, credit)" },
    { t: "add", l: "+         return Posting.from_pair(debit, credit, idem_key=idem_key)" },
    { t: "mut", l: "" },
    { t: "mut", l: "billing/ledger/posting/__init__.py" },
    { t: "add", l: "+ from .double_entry import commit, IdemKey" },
    { t: "del", l: "- from .simple import commit" },
  ];
  return (
    <Card title="patch-T-004.diff" action={<><Chip tone="success" mono>+312</Chip><Chip tone="rose" mono>-128</Chip></>}>
      <pre className="codeblock">
        {lines.map((l, i) => (
          <span key={i} className={l.t} style={{ display: "block" }}>{l.l || " "}</span>
        ))}
      </pre>
    </Card>
  );
};

const EventsView = ({ events }) => {
  const KIND_TONE = { task: "cobalt", review: "violet", approval: "warn", audit: "success", artifact: "neutral", error: "rose" };
  const KIND_ICON = { task: "play", review: "shield", approval: "check", audit: "check", artifact: "file", error: "alert" };
  return (
    <Card>
      <div className="col" style={{ gap: 0 }}>
        {events.map((e, i) => (
          <div key={i} className="row gap-3" style={{ padding: "10px 4px", borderTop: i ? "1px solid var(--hairline)" : "none" }}>
            <IconBezel tone={KIND_TONE[e.kind] || "neutral"} size="sm" icon={KIND_ICON[e.kind] || "dot"} />
            <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)", width: 64 }}>{rel(e.at)}</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)", width: 96 }}>{e.ref}</span>
            <span style={{ fontSize: 13, color: "var(--ink-2)", flex: 1 }}>{e.body}</span>
          </div>
        ))}
      </div>
    </Card>
  );
};

const ArtifactsRunView = ({ data }) => {
  const ART_ICON = { plan: "file", patch: "wrench", review: "shield", test: "ledger", "completion-audit": "shield", "pr-summary": "git-merge", evidence: "package" };
  const ART_TONE = { plan: "neutral", patch: "cobalt-soft", review: "violet", test: "warn", "completion-audit": "success", "pr-summary": "success", evidence: "neutral" };
  return (
    <Card title="Run artifacts">
      <div className="table" style={{ background: "transparent", boxShadow: "none", padding: 0 }}>
        {data.artifacts.slice(0, 5).map((a, i) => (
          <div key={a.id} className="trow" style={{ gridTemplateColumns: "32px 1.5fr 0.7fr 90px 80px 60px", padding: "10px 8px" }}>
            <IconBezel tone={ART_TONE[a.kind] || "neutral"} size="sm" icon={ART_ICON[a.kind] || "file"} />
            <div className="col" style={{ lineHeight: 1.25 }}>
              <span className="primary-cell mono" style={{ fontSize: 12.5 }}>{a.name}</span>
              <span className="meta-cell">{a.kind}</span>
            </div>
            <span className="meta-cell mono truncate">{a.run}</span>
            <span className="meta-cell mono">{a.size}</span>
            <span className="meta-cell mono">{rel(a.at)}</span>
            {a.tag ? <Chip tone={a.tag.includes("fail") ? "rose" : a.tag.includes("finding") ? "warn" : a.tag.includes("merged") || a.tag.includes("passed") || a.tag.includes("approved") ? "success" : "neutral"}>{a.tag}</Chip> : <span />}
          </div>
        ))}
      </div>
    </Card>
  );
};

// ---------- Task inspector ---------------------------------------------
const TaskInspector = ({ task, onClose }) => {
  if (!task) return null;
  const m = STATUS_META[task.status];
  return (
    <Inspector
      title={task.title}
      subtitle={`${task.id} · ${task.phase}`}
      icon={m.cls === "running" ? "play" : m.cls === "review" ? "shield" : m.cls === "merged" ? "check" : "circle"}
      tone={m.tone}
      onClose={onClose}
    >
      <div className="section">
        <div className="row gap-3" style={{ marginBottom: 6 }}>
          <Chip tone={m.tone} dot>{m.label}</Chip>
          {task.risk ? <Chip tone={task.risk === "high" ? "rose" : task.risk === "med" ? "warn" : "neutral"}>{task.risk} risk</Chip> : null}
        </div>
        <FieldRow label="Branch">
          <span className="mono">{task.branch}</span>
        </FieldRow>
        <FieldRow label="Scope">
          <span className="mono" style={{ fontSize: 12.5 }}>{task.scope}</span>
        </FieldRow>
        <FieldRow label="Review">{task.review}</FieldRow>
        <FieldRow label="Budget"><span className="mono">${task.budget.toFixed(2)}</span></FieldRow>
      </div>

      <div className="section">
        <h3 className="h3">Latest activity</h3>
        <div className="col" style={{ gap: 6, marginTop: 6, fontSize: 12.5, color: "var(--ink-3)" }}>
          <div className="row gap-2"><span className="mono" style={{ color: "var(--ink-4)", width: 50 }}>2m ago</span><span style={{ color: "var(--ink-2)" }}>Implementation agent started run #3</span></div>
          <div className="row gap-2"><span className="mono" style={{ color: "var(--ink-4)", width: 50 }}>14m</span><span>Patch generated — 4 files, +186/-92</span></div>
          <div className="row gap-2"><span className="mono" style={{ color: "var(--ink-4)", width: 50 }}>22m</span><span>Sandbox test pass: 84/86</span></div>
          <div className="row gap-2"><span className="mono" style={{ color: "var(--ink-4)", width: 50 }}>41m</span><span>2 review findings raised</span></div>
        </div>
      </div>

      <div className="section">
        <h3 className="h3">Actions</h3>
        <div className="row gap-3" style={{ marginTop: 6, flexWrap: "wrap" }}>
          <Button kind="primary" size="sm" icon="play">Re-run</Button>
          <Button kind="subtle" size="sm" icon="panel-right">Open diff</Button>
          <Button kind="subtle" size="sm" icon="shield">Review</Button>
          <Button kind="ghost" size="sm" icon="more" title="More" />
        </div>
      </div>
    </Inspector>
  );
};

// ---------- Run Detail page --------------------------------------------
const RunDetail = ({ data, run, onBack }) => {
  const [tab, setTab] = useStateRD("cockpit");
  const [selectedTask, setSelectedTask] = useStateRD(null);
  const m = STATUS_META[run.status];

  return (
    <div className="split">
      <div className="main-content">
        <div className="main-scroll">
          <div className="page">
            <div className="page-header" style={{ alignItems: "start" }}>
              <Button kind="ghost" size="sm" icon="chevron-right" onClick={onBack} title="Back">
                <span style={{ transform: "rotate(180deg)", display: "inline-flex" }}><Icon name="chevron-right" size={12} strokeWidth={1.7} /></span>
              </Button>
              <div className="flex1">
                <div className="row gap-3" style={{ marginBottom: 4 }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ink-4)" }}>{run.id}</span>
                  <span className="muted">·</span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{run.repo}</span>
                  <StatusChip status={run.status} />
                </div>
                <h1 className="h1">{run.title}</h1>
                <div className="sub">{run.phase} · {run.progress.done} of {run.progress.total} tasks · updated {rel(run.updated)}</div>
              </div>
              <Button kind="subtle" icon="panel-right">Inspector</Button>
              <Button kind="primary" icon="play">Resume</Button>
            </div>

            {run.blocker ? (
              <div className="row gap-3" style={{ padding: "10px 14px", background: run.status === "failed" ? "var(--rose-soft)" : "var(--amber-soft)", borderRadius: 12, color: run.status === "failed" ? "var(--rose)" : "var(--amber)", fontSize: 13, boxShadow: "inset 0 0 0 1px rgba(180,83,9,0.18)" }}>
                <IconBezel tone={run.status === "failed" ? "rose" : "warn"} size="sm" icon="alert" />
                <div className="col flex1" style={{ lineHeight: 1.25 }}>
                  <span style={{ fontWeight: 500, color: "var(--ink)" }}>Run is blocked</span>
                  <span style={{ color: run.status === "failed" ? "var(--rose)" : "var(--amber)" }}>{run.blocker}</span>
                </div>
                <Button kind="subtle" size="sm" icon="check">Review</Button>
              </div>
            ) : null}

            <div className="row gap-4 between">
              <div className="tabs">
                {RUN_TABS.map(t => (
                  <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
                ))}
              </div>
              <div className="row gap-3" style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                <span className="row gap-2"><IconBezel tone="cobalt-soft" size="sm" icon="spark" /><span className="mono">claude · sonnet 4.5</span></span>
              </div>
            </div>

            {tab === "cockpit" && <Cockpit data={data} run={run} onSelectTask={setSelectedTask} selectedTaskId={selectedTask?.id} />}
            {tab === "plan" && <PlanView run={run} />}
            {tab === "findings" && <FindingsView data={data} />}
            {tab === "diff" && <DiffView />}
            {tab === "events" && <EventsView events={data.events} />}
            {tab === "artifacts" && <ArtifactsRunView data={data} />}
          </div>
        </div>
      </div>
      {selectedTask ? <TaskInspector task={selectedTask} onClose={() => setSelectedTask(null)} /> : null}
    </div>
  );
};

window.RunDetail = RunDetail;
