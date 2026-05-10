/* global React, Card, IconBezel, Icon, Chip, StatusChip, StatusDot, Button, ProgressBar, rel, STATUS_META, Inspector, FieldRow */
const { useState: useStateRuns, useMemo: useMemoRuns } = React;

// ---------- Runs list -------------------------------------------------
const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "in_review", label: "Review" },
  { id: "blocked", label: "Blocked" },
  { id: "ready_to_merge", label: "Ready" },
  { id: "released", label: "Released" },
  { id: "failed", label: "Failed" },
];

const RunsList = ({ data, onOpenRun, selectedRunId }) => {
  const [status, setStatus] = useStateRuns("all");
  const [q, setQ] = useStateRuns("");
  const filtered = useMemoRuns(() => data.runs.filter(r =>
    (status === "all" || r.status === status) &&
    (!q || (r.title + r.repo + r.id).toLowerCase().includes(q.toLowerCase()))
  ), [status, q, data.runs]);

  const cols = "26px 1.4fr 0.7fr 130px 90px 80px 56px";

  return (
    <div className="page">
      <div className="page-header">
        <div className="flex1">
          <h1 className="h1">Runs</h1>
          <div className="sub">Every active and historical execution of a spec through the workflow.</div>
        </div>
        <Button kind="subtle" icon="filter">Owner: all</Button>
        <Button kind="primary" icon="plus">New spec</Button>
      </div>

      <div className="row gap-4 between" style={{ flexWrap: "wrap", gap: 12 }}>
        <div className="filterbar">
          {STATUS_FILTERS.map(f => (
            <button key={f.id} className={`filter${status === f.id ? " active" : ""}`} onClick={() => setStatus(f.id)}>{f.label}</button>
          ))}
        </div>
        <div className="bezel-input" style={{ width: 280 }}>
          <Icon name="search" size={14} strokeWidth={1.7} style={{ color: "var(--ink-4)" }} />
          <input placeholder="Search runs, repos, IDs…" value={q} onChange={e => setQ(e.target.value)} />
          <span className="kbd">/</span>
        </div>
      </div>

      <div className="table">
        <div className="thead" style={{ gridTemplateColumns: cols }}>
          <span></span>
          <span>Run · Title</span>
          <span>Repo</span>
          <span>Phase</span>
          <span>Progress</span>
          <span>Updated</span>
          <span style={{ textAlign: "right" }}>Owner</span>
        </div>
        {filtered.map(r => (
          <div key={r.id}
              className={`trow${selectedRunId === r.id ? " selected" : ""}`}
              style={{ gridTemplateColumns: cols }}
              onClick={() => onOpenRun(r)}>
            <StatusDot status={r.status} />
            <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
              <span className="primary-cell truncate">{r.title}</span>
              <span className="meta-cell mono">{r.id} · {STATUS_META[r.status].label.toLowerCase()}</span>
            </div>
            <span className="meta-cell mono truncate">{r.repo}</span>
            <span className="meta-cell truncate">{r.phase}</span>
            <div className="col gap-2" style={{ minWidth: 0, gap: 4 }}>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{r.progress.done}/{r.progress.total}</span>
              <ProgressBar value={r.progress.done} max={r.progress.total} green={r.status === "released" || r.status === "ready_to_merge"} />
            </div>
            <span className="mono meta-cell">{rel(r.updated)}</span>
            <span style={{ textAlign: "right" }}><span className="pebble" style={{ display: "inline-grid" }}>{r.owner}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
};

window.RunsList = RunsList;
