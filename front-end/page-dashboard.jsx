/* global React, Card, IconBezel, Icon, Chip, StatusChip, StatusDot, Button, ProgressBar, rel, STATUS_META */
const { useState: useStateDash } = React;

// ---------- Dashboard --------------------------------------------------
const DashStatTile = ({ tone, icon, value, label, sub, mono }) => (
  <div className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, minHeight: 78 }}>
    <IconBezel tone={tone} size="lg" icon={icon} />
    <div className="col flex1" style={{ lineHeight: 1.2, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className={mono ? "mono" : ""} style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--ink)" }}>{value}</span>
        {sub ? <span className="muted" style={{ fontSize: 12 }}>{sub}</span> : null}
      </div>
      <span className="eyebrow" style={{ paddingTop: 2 }}>{label}</span>
    </div>
  </div>
);

const ActiveRunCard = ({ run, onOpen }) => {
  const meta = STATUS_META[run.status];
  const pct = Math.round((run.progress.done / run.progress.total) * 100);
  return (
    <div
      className="card"
      style={{ padding: "14px 16px", cursor: "pointer" }}
      onClick={() => onOpen(run)}
    >
      <div className="row gap-3" style={{ marginBottom: 6 }}>
        <StatusDot status={run.status} />
        <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{run.id}</span>
        <span className="muted mono" style={{ fontSize: 11.5 }}>·</span>
        <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{run.repo}</span>
        <div className="topbar-spacer" />
        <Chip tone={meta.tone} dot>{meta.label}</Chip>
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 500, color: "var(--ink)", marginBottom: 8, letterSpacing: "-0.005em" }}>
        {run.title}
      </div>
      <div className="row gap-3" style={{ marginBottom: 10, color: "var(--ink-3)", fontSize: 12.5 }}>
        <Icon name="workflow" size={12} strokeWidth={1.7} />
        <span>{run.phase}</span>
        <span className="muted">·</span>
        <span className="mono">{run.progress.done}/{run.progress.total} tasks</span>
        <div className="topbar-spacer" />
        <span className="mono" style={{ color: "var(--ink-4)", fontSize: 11.5 }}>{rel(run.updated)}</span>
      </div>
      <ProgressBar value={run.progress.done} max={run.progress.total} green={run.status === "ready_to_merge" || run.status === "released"} />
      {run.blocker ? (
        <div className="row gap-3" style={{ marginTop: 10, padding: "8px 10px", background: run.status === "failed" ? "var(--rose-soft)" : "var(--amber-soft)", borderRadius: 8, color: run.status === "failed" ? "var(--rose)" : "var(--amber)", fontSize: 12.5 }}>
          <Icon name="alert" size={13} strokeWidth={1.7} />
          <span>{run.blocker}</span>
        </div>
      ) : null}
    </div>
  );
};

const StackHealthCard = ({ stack }) => {
  const sb = stack.sandbox, gt = stack.git, rv = stack.review, bd = stack.budget;
  return (
    <Card title="Stack" action={<Chip tone="success" dot>Healthy</Chip>}>
      <div className="col gap-4" style={{ gap: 10 }}>
        <div className="row gap-3">
          <IconBezel tone="cobalt-soft" size="sm" icon="spark" />
          <div className="col flex1" style={{ lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Runtime</span>
            <span className="mono muted" style={{ fontSize: 11.5 }}>{stack.runtime}</span>
          </div>
          <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{stack.runtimeLatency}ms</span>
        </div>
        <div className="row gap-3">
          <IconBezel tone="neutral" size="sm" icon="package" />
          <div className="col flex1" style={{ lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Sandbox</span>
            <span className="muted" style={{ fontSize: 11.5 }}>queue · capacity</span>
          </div>
          <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{sb.queue}/{sb.capacity}</span>
        </div>
        <div className="row gap-3">
          <IconBezel tone="neutral" size="sm" icon="branch" />
          <div className="col flex1" style={{ lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Git remote</span>
            <span className="muted" style={{ fontSize: 11.5 }}>{gt.remote}</span>
          </div>
          <Chip tone="success" dot>OK</Chip>
        </div>
        <div className="row gap-3">
          <IconBezel tone="neutral" size="sm" icon="shield" />
          <div className="col flex1" style={{ lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Review model</span>
            <span className="muted mono" style={{ fontSize: 11.5 }}>{rv.model}</span>
          </div>
          <Chip tone="success" dot>OK</Chip>
        </div>
        <div className="divider" style={{ margin: "4px 0" }} />
        <div className="row gap-3">
          <IconBezel tone="warn" size="sm" icon="ledger" />
          <div className="col flex1" style={{ lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Daily budget</span>
            <span className="muted mono" style={{ fontSize: 11.5 }}>${bd.spent.toFixed(2)} of ${bd.ceiling.toFixed(2)}</span>
          </div>
          <Chip tone="warn" dot>73%</Chip>
        </div>
        <div className="bar" style={{ marginTop: -2 }}><span style={{ width: `${(bd.spent / bd.ceiling) * 100}%`, background: "linear-gradient(180deg, #DBA259 0%, #B45309 100%)" }} /></div>
      </div>
    </Card>
  );
};

const RecentEventsCard = ({ events }) => {
  const KIND_ICON = { task: "play", review: "shield", approval: "check", audit: "check", artifact: "file", error: "alert" };
  const KIND_TONE = { task: "cobalt", review: "violet", approval: "warn", audit: "success", artifact: "neutral", error: "rose" };
  return (
    <Card title="Recent activity" action={<Button kind="ghost" size="sm" iconRight="arrow-right">Drawer</Button>}>
      <div className="col" style={{ gap: 2 }}>
        {events.slice(0, 6).map((e, i) => (
          <div key={i} className="row gap-3" style={{ padding: "8px 4px", borderRadius: 8 }}>
            <IconBezel tone={KIND_TONE[e.kind]} size="sm" icon={KIND_ICON[e.kind] || "dot"} />
            <span className="mono" style={{ color: "var(--ink-4)", fontSize: 11.5, width: 56 }}>{rel(e.at)}</span>
            <span className="mono" style={{ color: "var(--ink-3)", fontSize: 11.5, width: 82 }}>{e.ref}</span>
            <span className="flex1" style={{ fontSize: 13, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.body}</span>
          </div>
        ))}
      </div>
    </Card>
  );
};

const ApprovalQueueCard = ({ approvals, onOpen }) => (
  <Card title="Awaiting your approval" action={<Chip tone="warn" mono>{approvals.length}</Chip>}>
    <div className="col" style={{ gap: 8 }}>
      {approvals.map(a => (
        <div key={a.id} className="row gap-3" style={{ padding: 10, borderRadius: 10, background: "linear-gradient(180deg, #FFFEF8 0%, #FBF5E5 100%)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.85), inset 0 0 0 1px rgba(180,83,9,0.14)", cursor: "pointer" }}
            onClick={() => onOpen(a)}>
          <IconBezel tone="warn" size="sm" icon="approve" />
          <div className="col flex1" style={{ lineHeight: 1.25, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.subject}</span>
            <span className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.reason}</span>
          </div>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{a.id}</span>
          <Icon name="chevron-right" size={14} strokeWidth={1.7} style={{ color: "var(--ink-4)" }} />
        </div>
      ))}
    </div>
  </Card>
);

const Dashboard = ({ data, onOpenRun, onOpenApproval, onGoto }) => {
  const active = data.runs.filter(r => ["running", "in_review", "blocked", "fixing"].includes(r.status));
  const readyMerge = data.runs.filter(r => r.status === "ready_to_merge").length;
  return (
    <div className="page">
      <div className="page-header">
        <div className="flex1">
          <h1 className="h1">Good afternoon, Jordan</h1>
          <div className="sub">3 runs active · 1 awaiting approval · stack healthy</div>
        </div>
        <Button kind="subtle" icon="calendar">Last 7d</Button>
        <Button kind="primary" icon="plus" onClick={() => onGoto("new-spec")}>New spec</Button>
      </div>

      <div className="grid grid-3">
        <DashStatTile tone="cobalt" icon="play" value="3" label="Active runs" sub="of 7" />
        <DashStatTile tone="warn" icon="approve" value="4" label="Approvals waiting" sub="oldest 28m" />
        <DashStatTile tone="success" icon="git-merge" value={String(readyMerge)} label="Ready to merge" sub="ui-kit v4.2.0" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
        <div className="col gap-4" style={{ gap: 14 }}>
          <Card title="Active runs" action={<Button kind="ghost" size="sm" iconRight="arrow-right" onClick={() => onGoto("runs")}>All runs</Button>}>
            <div className="col" style={{ gap: 10 }}>
              {active.map(r => <ActiveRunCard key={r.id} run={r} onOpen={onOpenRun} />)}
            </div>
          </Card>
          <ApprovalQueueCard approvals={data.approvals.slice(0, 3)} onOpen={onOpenApproval} />
        </div>
        <div className="col gap-4" style={{ gap: 14 }}>
          <StackHealthCard stack={data.stack} />
          <RecentEventsCard events={data.events} />
        </div>
      </div>
    </div>
  );
};

window.Dashboard = Dashboard;
