/* global React, Card, IconBezel, Icon, Chip, StatusChip, StatusDot, Button, ProgressBar, rel, STATUS_META, Inspector, FieldRow */
const { useState: useStateO, useMemo: useMemoO, useEffect: useEffectO, useRef: useRefO } = React;

// ===== Approvals =======================================================
const ApprovalsPage = ({ data, onOpenRun }) => {
  const [active, setActive] = useStateO(data.approvals[0]?.id || null);
  const a = data.approvals.find(x => x.id === active) || data.approvals[0];

  const RISK_TONE = { high: "rose", med: "warn", low: "neutral" };

  return (
    <div className="page">
      <div className="page-header">
        <div className="flex1">
          <h1 className="h1">Approvals</h1>
          <div className="sub">Human-required gates. Approve, reject, or request changes. Older items first.</div>
        </div>
        <Button kind="subtle" icon="filter">All risk</Button>
        <Chip tone="warn" mono>{data.approvals.length} pending</Chip>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1.4fr" }}>
        <Card title="Queue" padding="6px 6px">
          <div className="col" style={{ gap: 2 }}>
            {data.approvals.map(x => (
              <div key={x.id}
                  className={`trow${active === x.id ? " selected" : ""}`}
                  style={{ gridTemplateColumns: "26px 1fr 60px", padding: "10px 12px", display: "grid" }}
                  onClick={() => setActive(x.id)}>
                <IconBezel tone="warn" size="sm" icon="approve" />
                <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
                  <span className="primary-cell truncate">{x.subject}</span>
                  <span className="meta-cell mono">{x.id} · {x.run} · {rel(x.created)}</span>
                </div>
                <Chip tone={RISK_TONE[x.risk]} dot>{x.risk}</Chip>
              </div>
            ))}
          </div>
        </Card>

        {a ? (
          <Card>
            <div className="row gap-4" style={{ marginBottom: 14 }}>
              <IconBezel tone="warn" size="lg" icon="approve" />
              <div className="col flex1" style={{ lineHeight: 1.25 }}>
                <h2 className="h2">{a.subject}</h2>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  <span className="mono">{a.id}</span> · created {rel(a.created)} · risk
                  <Chip tone={RISK_TONE[a.risk]} dot>{a.risk}</Chip>
                </div>
              </div>
            </div>

            <div className="col" style={{ gap: 14 }}>
              <FieldRow label="Run">
                <a className="mono" style={{ color: "var(--cobalt-strong)", cursor: "pointer" }}
                   onClick={() => onOpenRun(data.runs.find(r => r.id === a.run))}>
                   {a.run}
                </a>
              </FieldRow>
              {a.task ? <FieldRow label="Task"><span className="mono">{a.task}</span></FieldRow> : null}
              <FieldRow label="Recommendation">
                <Chip tone={a.recommend === "approve" ? "success" : "warn"} dot>
                  Agent recommends: {a.recommend}
                </Chip>
              </FieldRow>
              <div>
                <span className="eyebrow">Reasoning</span>
                <p style={{ marginTop: 6, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55 }}>{a.reason}</p>
              </div>
              <Card padding="12px 14px">
                <div className="eyebrow" style={{ marginBottom: 8 }}>Evidence</div>
                <div className="col" style={{ gap: 6, fontSize: 12.5 }}>
                  <div className="row gap-3"><IconBezel tone="neutral" size="sm" icon="file" /><span className="mono">review-T-005.md</span><span className="muted">· 8.4 KB</span></div>
                  <div className="row gap-3"><IconBezel tone="neutral" size="sm" icon="ledger" /><span className="mono">test-report-T-005.json</span><span className="muted">· 12 KB</span></div>
                  <div className="row gap-3"><IconBezel tone="neutral" size="sm" icon="wrench" /><span className="mono">patch-T-005.diff</span><span className="muted">· 4.1 KB</span></div>
                </div>
              </Card>

              <div className="row gap-3" style={{ marginTop: 6 }}>
                <Button kind="success" icon="check">Approve</Button>
                <Button kind="subtle" icon="wrench">Request changes</Button>
                <Button kind="danger-ghost" icon="x">Reject</Button>
                <div className="topbar-spacer" />
                <span className="muted" style={{ fontSize: 12.5 }}>⌘↵ approve · ⌘⌫ reject</span>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
};

// ===== New Spec ========================================================
const SpecExample = `# Migrate billing service to event-sourced ledger

## Goal
Replace the current row-mutating balance table with an append-only ledger model
that produces strong audit trails across all tenants.

## Constraints
- Wire compatibility on existing balance & history endpoints
- Reconciliation report must run nightly
- Zero downtime cutover via shadow dual-write

## Acceptance criteria
- [ ] All postings idempotent under retry
- [ ] Reconciliation reports zero discrepancies for 7 consecutive days
- [ ] Audit log records every mutation (actor, reason, request_id)
`;

const NewSpec = ({ data, onCreate }) => {
  const [spec, setSpec] = useStateO(SpecExample);
  const [repo, setRepo] = useStateO("repo-billing");
  const r = data.repos.find(x => x.id === repo);
  const intel = data.repoIntel;
  return (
    <div className="page">
      <div className="page-header">
        <div className="flex1">
          <h1 className="h1">New spec</h1>
          <div className="sub">Describe the change. pm-go will decompose it, plan it, and run the work.</div>
        </div>
        <Button kind="subtle" icon="file">Templates</Button>
        <Button kind="primary" icon="spark" onClick={onCreate}>Submit to plan</Button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div className="col gap-4" style={{ gap: 14 }}>
          <Card>
            <div className="row gap-3" style={{ marginBottom: 12 }}>
              <IconBezel tone="cobalt-soft" size="md" icon="branch" />
              <div className="col flex1">
                <div className="row gap-3"><span className="eyebrow">Target repo</span></div>
                <select className="mono"
                    style={{ appearance: "none", background: "transparent", border: 0, outline: 0,
                             fontSize: 14, fontWeight: 500, color: "var(--ink)", padding: 0,
                             marginTop: 2, cursor: "pointer" }}
                    value={repo} onChange={e => setRepo(e.target.value)}>
                  {data.repos.map(rp => <option key={rp.id} value={rp.id}>{rp.path}</option>)}
                </select>
              </div>
              <Chip tone="neutral" mono>{r.branch}</Chip>
              <Chip tone="neutral" mono>{r.sha}</Chip>
            </div>
            <div className="editor-pane">
              <div className="editor-toolbar">
                <button>H1</button><button>H2</button><button>B</button><button>I</button>
                <button>{'`code`'}</button><button>—</button>
                <div className="topbar-spacer" />
                <span className="muted mono" style={{ fontSize: 11 }}>markdown · {spec.split("\n").length} lines</span>
              </div>
              <textarea className="editor-area" rows={20}
                value={spec} onChange={e => setSpec(e.target.value)} />
            </div>
          </Card>

          <Card title="Plan preview" action={<Chip tone="cobalt" dot>From spec</Chip>}>
            <div className="col" style={{ gap: 8 }}>
              {[
                "Phase 1 · Schema migrations · 3 tasks",
                "Phase 2 · Ledger write path · 5 tasks",
                "Phase 3 · Read API & reconciliation · 3 tasks",
                "Phase 4 · Cutover & shadow run · 1 task",
              ].map((label, i) => (
                <div key={i} className="row gap-3" style={{ padding: "8px 10px", background: "var(--panel-soft)", borderRadius: 10 }}>
                  <span className="mono" style={{ width: 22, color: "var(--ink-4)", fontSize: 11.5 }}>{i + 1}</span>
                  <span style={{ fontSize: 13.5 }}>{label}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="col gap-4" style={{ gap: 14 }}>
          <Card title="Repo intelligence" action={<Chip tone="success" dot>Fresh</Chip>}>
            <div className="col" style={{ gap: 10, fontSize: 13 }}>
              <FieldRow label="Branch"><span className="mono">{intel.branch} · {intel.sha}</span></FieldRow>
              <FieldRow label="Languages">
                <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                  {intel.languages.map(l => <Chip key={l} tone="cobalt" mono>{l}</Chip>)}
                </div>
              </FieldRow>
              <FieldRow label="Frameworks">
                <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                  {intel.frameworks.map(l => <Chip key={l} tone="neutral" mono>{l}</Chip>)}
                </div>
              </FieldRow>
              <FieldRow label="Build">
                <div className="col" style={{ gap: 4 }}>{intel.build.map(b => <span key={b} className="mono" style={{ fontSize: 12 }}>$ {b}</span>)}</div>
              </FieldRow>
              <FieldRow label="Test">
                <div className="col" style={{ gap: 4 }}>{intel.test.map(b => <span key={b} className="mono" style={{ fontSize: 12 }}>$ {b}</span>)}</div>
              </FieldRow>
            </div>
          </Card>

          <Card title="Runtime">
            <div className="col" style={{ gap: 10 }}>
              <div className="row gap-3">
                <IconBezel tone="cobalt-soft" size="sm" icon="spark" />
                <div className="col flex1"><span style={{ fontSize: 13, fontWeight: 500 }}>Claude · Sonnet 4.5</span><span className="muted mono" style={{ fontSize: 11.5 }}>default · 200k ctx</span></div>
                <Chip tone="cobalt" dot>Selected</Chip>
              </div>
              <div className="row gap-3" style={{ opacity: 0.7 }}>
                <IconBezel tone="neutral" size="sm" icon="spark" />
                <div className="col flex1"><span style={{ fontSize: 13, fontWeight: 500 }}>SDK · stub</span><span className="muted mono" style={{ fontSize: 11.5 }}>local · for testing</span></div>
              </div>
              <FieldRow label="Budget cap">
                <div className="bezel-input" style={{ padding: "4px 10px" }}>
                  <span className="mono" style={{ color: "var(--ink-4)" }}>$</span>
                  <input defaultValue="25.00" style={{ fontFamily: "var(--font-mono)" }} />
                </div>
              </FieldRow>
              <FieldRow label="Auto-approve">
                <Chip tone="neutral" dot>Low-risk only</Chip>
              </FieldRow>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

// ===== Workflow Builder ================================================
const WorkflowBuilder = ({ data }) => {
  const [sel, setSel] = useStateO("n7");
  const tpl = data.workflowTemplate;
  const byId = useMemoO(() => Object.fromEntries(tpl.nodes.map(n => [n.id, n])), [tpl]);
  const W = 1240, H = 540;

  const path = (a, b) => {
    const sx = a.x + 90, sy = a.y + 22;
    const ex = b.x + 10, ey = b.y + 22;
    const c1 = sx + 60, c2 = ex - 60;
    return `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ey}, ${ex} ${ey}`;
  };

  const KIND_ICON = {
    spec: "file", snapshot: "branch", decompose: "stack", plan: "workflow",
    approval: "approve", partition: "stack", parallel: "panel-right",
    implement: "wrench", review: "shield", fix: "wrench", budget: "ledger",
    integration: "git-merge", "audit-phase": "shield", "audit-final": "shield",
    release: "package", artifact: "file",
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="flex1">
          <h1 className="h1">Workflow</h1>
          <div className="sub">The template every run executes. Click a node to inspect or override.</div>
        </div>
        <Button kind="subtle" icon="file">Templates</Button>
        <Button kind="primary" icon="check">Save</Button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 320px" }}>
        <Card padding="14px">
          <div className="wf-canvas" style={{ height: H, width: "100%", overflow: "auto" }}>
            <div style={{ position: "relative", width: W, height: H }}>
              <svg className="wf-edges" width={W} height={H}>
                {tpl.edges.map(([a, b], i) => {
                  const A = byId[a], B = byId[b];
                  const active = sel === a || sel === b;
                  return (
                    <path key={i} d={path(A, B)}
                      stroke={active ? "rgba(37,99,235,0.55)" : "rgba(20,22,20,0.20)"}
                      strokeWidth={active ? 1.8 : 1.2}
                      strokeDasharray={B.kind === "fix" || A.kind === "fix" ? "3 4" : ""}
                    />
                  );
                })}
              </svg>
              {tpl.nodes.map(n => (
                <div key={n.id}
                    className={`wf-node${sel === n.id ? " selected" : ""}`}
                    style={{ left: n.x, top: n.y }}
                    onClick={() => setSel(n.id)}>
                  <IconBezel tone={n.tone} size="sm" icon={KIND_ICON[n.kind] || "dot"} />
                  <div className="col" style={{ lineHeight: 1.2 }}>
                    <span className="name">{n.name}</span>
                    <span className="kind">{n.kind}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          {(() => {
            const n = byId[sel];
            return (
              <>
                <div className="row gap-3" style={{ marginBottom: 12 }}>
                  <IconBezel tone={n.tone} size="lg" icon={KIND_ICON[n.kind] || "dot"} />
                  <div className="col">
                    <h3 className="h3">{n.name}</h3>
                    <span className="mono muted" style={{ fontSize: 12 }}>{n.kind}</span>
                  </div>
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <FieldRow label="Concurrency"><span className="mono">8 in parallel</span></FieldRow>
                  <FieldRow label="Timeout"><span className="mono">45 min / task</span></FieldRow>
                  <FieldRow label="Retries"><span className="mono">2 (exp backoff)</span></FieldRow>
                  <FieldRow label="On failure">Send to Fix Loop</FieldRow>
                  <FieldRow label="Sandbox">isolated · resource-cap</FieldRow>
                </div>
                <div className="divider" style={{ margin: "14px 0" }} />
                <div className="eyebrow" style={{ marginBottom: 8 }}>Connected to</div>
                <div className="col" style={{ gap: 6 }}>
                  {tpl.edges.filter(([a, b]) => a === sel || b === sel).map(([a, b], i) => (
                    <div key={i} className="row gap-3" style={{ fontSize: 12.5 }}>
                      <span className="mono" style={{ color: "var(--ink-4)", width: 30 }}>{a === sel ? "out" : "in"}</span>
                      <span style={{ fontWeight: 500 }}>{byId[a === sel ? b : a].name}</span>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </Card>
      </div>
    </div>
  );
};

// ===== Artifacts =======================================================
const ArtifactsPage = ({ data }) => {
  const ART_ICON = { plan: "file", patch: "wrench", review: "shield", test: "ledger", "completion-audit": "shield", "pr-summary": "git-merge", evidence: "package" };
  const ART_TONE = { plan: "neutral", patch: "cobalt-soft", review: "violet", test: "warn", "completion-audit": "success", "pr-summary": "success", evidence: "neutral" };
  const [filter, setFilter] = useStateO("all");
  const filtered = filter === "all" ? data.artifacts : data.artifacts.filter(a => a.kind === filter);
  const tagTone = (tag) => tag.includes("fail") ? "rose" : tag.includes("finding") ? "warn" : (tag.includes("merged") || tag.includes("passed") || tag.includes("approved")) ? "success" : "neutral";

  const cols = "36px 1.4fr 0.7fr 90px 100px 120px";

  return (
    <div className="page">
      <div className="page-header">
        <div className="flex1">
          <h1 className="h1">Artifacts</h1>
          <div className="sub">Plans, patches, reviews, audits, evidence bundles — every byte produced by a run.</div>
        </div>
        <Button kind="subtle" icon="filter">Run: all</Button>
        <Button kind="subtle" icon="file">Export</Button>
      </div>

      <div className="filterbar">
        {["all","plan","patch","review","test","completion-audit","pr-summary","evidence"].map(k => (
          <button key={k} className={`filter${filter === k ? " active" : ""}`} onClick={() => setFilter(k)}>{k.replace("-", " ")}</button>
        ))}
      </div>

      <div className="table">
        <div className="thead" style={{ gridTemplateColumns: cols }}>
          <span></span>
          <span>Artifact</span>
          <span>Run</span>
          <span>Size</span>
          <span>Created</span>
          <span style={{ textAlign: "right" }}>Status</span>
        </div>
        {filtered.map(a => (
          <div key={a.id} className="trow" style={{ gridTemplateColumns: cols }}>
            <IconBezel tone={ART_TONE[a.kind] || "neutral"} size="md" icon={ART_ICON[a.kind] || "file"} />
            <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
              <span className="primary-cell mono truncate">{a.name}</span>
              <span className="meta-cell">{a.kind.replace("-", " ")} · {a.id}</span>
            </div>
            <span className="meta-cell mono truncate">{a.run}</span>
            <span className="meta-cell mono">{a.size}</span>
            <span className="meta-cell mono">{rel(a.at)}</span>
            <span style={{ textAlign: "right" }}>
              {a.tag ? <Chip tone={tagTone(a.tag)} dot={a.tag !== ""}>{a.tag}</Chip> : <span className="muted">—</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ===== Settings ========================================================
const SettingsPage = () => {
  const [auto, setAuto] = useStateO("low");
  return (
    <div className="page">
      <div className="page-header">
        <div className="flex1">
          <h1 className="h1">Settings</h1>
          <div className="sub">Workspace defaults applied to every new run.</div>
        </div>
      </div>

      <div className="grid grid-2">
        <Card title="Runtime">
          <div className="col" style={{ gap: 10 }}>
            <FieldRow label="Default model"><span className="mono">claude · sonnet 4.5</span></FieldRow>
            <FieldRow label="Fallback"><span className="mono">claude · haiku 4.5</span></FieldRow>
            <FieldRow label="Context window"><span className="mono">200,000 tokens</span></FieldRow>
            <FieldRow label="Daily budget cap">
              <div className="bezel-input" style={{ padding: "4px 10px", maxWidth: 140 }}>
                <span className="mono" style={{ color: "var(--ink-4)" }}>$</span>
                <input defaultValue="25.00" style={{ fontFamily: "var(--font-mono)" }} />
              </div>
            </FieldRow>
          </div>
        </Card>

        <Card title="Approvals policy">
          <div className="col" style={{ gap: 10 }}>
            <div className="eyebrow">Auto-approve threshold</div>
            <div className="filterbar" style={{ alignSelf: "start" }}>
              {[["off","Off"],["low","Low risk"],["med","Low + medium"]].map(([id, label]) => (
                <button key={id} className={`filter${auto === id ? " active" : ""}`} onClick={() => setAuto(id)}>{label}</button>
              ))}
            </div>
            <FieldRow label="Plan gate">Always require human approval</FieldRow>
            <FieldRow label="Override gate">Always require human approval</FieldRow>
            <FieldRow label="Release gate">
              <Chip tone="success" dot>Require for tagged repos</Chip>
            </FieldRow>
          </div>
        </Card>

        <Card title="Sandbox">
          <div className="col" style={{ gap: 10 }}>
            <FieldRow label="Provider"><span className="mono">internal · k8s</span></FieldRow>
            <FieldRow label="Concurrency"><span className="mono">8 tasks</span></FieldRow>
            <FieldRow label="Per-task memory"><span className="mono">4 GB</span></FieldRow>
            <FieldRow label="Network egress"><Chip tone="warn" dot>Allowlist only</Chip></FieldRow>
            <FieldRow label="Storage retention"><span className="mono">90 days</span></FieldRow>
          </div>
        </Card>

        <Card title="Notifications">
          <div className="col" style={{ gap: 10 }}>
            <FieldRow label="Slack">
              <span className="mono">#pm-go-acme</span>
              <Chip tone="success" dot>Connected</Chip>
            </FieldRow>
            <FieldRow label="On approval needed"><Chip tone="cobalt" dot>Always</Chip></FieldRow>
            <FieldRow label="On run failure"><Chip tone="cobalt" dot>Always</Chip></FieldRow>
            <FieldRow label="On release"><Chip tone="neutral">Digest, 1×/day</Chip></FieldRow>
          </div>
        </Card>
      </div>
    </div>
  );
};

Object.assign(window, { ApprovalsPage, NewSpec, WorkflowBuilder, ArtifactsPage, SettingsPage });
