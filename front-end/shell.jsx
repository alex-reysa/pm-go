/* global React, Icon, IconBezel, Button, StatusDot, rel */
const { useState: useStateShell, useEffect: useEffectShell } = React;

// ---------- Sidebar ----------------------------------------------------
const NAV_ITEMS = [
  { id: "dashboard",  icon: "dashboard", label: "Dashboard" },
  { id: "new-spec",   icon: "plus",      label: "New spec" },
  { id: "runs",       icon: "play",      label: "Runs" },
  { id: "approvals",  icon: "check",     label: "Approvals" },
  { id: "workflow",   icon: "workflow",  label: "Workflow builder" },
  { id: "artifacts",  icon: "stack",     label: "Artifacts" },
  { id: "settings",   icon: "settings",  label: "Settings" },
];

const Sidebar = ({ route, onNavigate, counts }) => {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">pm</span>
        <span className="brand-name">pm-go<span className="dim"> · control</span></span>
      </div>
      <nav className="nav">
        {NAV_ITEMS.map((item, i) => {
          const active = route === item.id;
          const count = counts[item.id];
          return (
            <button
              key={item.id}
              className={`nav-item${active ? " active" : ""}`}
              onClick={() => onNavigate(item.id)}
            >
              <IconBezel
                tone={active ? "cobalt-soft" : "neutral"}
                size="sm"
                icon={item.icon}
              />
              <span className="label">{item.label}</span>
              {count != null ? <span className="count tnum">{count}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <span className="pebble">JE</span>
        <div className="col" style={{ lineHeight: 1.2 }}>
          <span style={{ color: "var(--ink)", fontSize: 12.5, fontWeight: 500 }}>Jordan Ellis</span>
          <span className="dim" style={{ fontSize: 11.5 }}>acme · platform</span>
        </div>
      </div>
    </aside>
  );
};

// ---------- TopBar -----------------------------------------------------
const TopBar = ({ route, activeRun, stack, onDiagnose, onOpenSpec }) => {
  // Page-specific title
  const title = {
    "dashboard": "Dashboard",
    "new-spec": "New spec",
    "runs": "Runs",
    "run-detail": activeRun?.title || "Run",
    "approvals": "Approvals",
    "workflow": "Workflow builder",
    "artifacts": "Artifacts",
    "settings": "Settings",
  }[route] || "";

  return (
    <header className="topbar">
      <div className="row gap-3">
        <Icon name="menu" size={16} strokeWidth={1.7} style={{ color: "var(--ink-3)" }} />
        <span className="muted" style={{ fontSize: 13 }}>pm-go</span>
        <Icon name="chevron-right" size={12} strokeWidth={1.5} style={{ color: "var(--ink-4)" }} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
      </div>

      <div className="topbar-spacer" />

      <div className="ctx">
        <span className="ctx-chip" title="Active repo">
          <IconBezel tone="neutral" size="sm" icon="branch" />
          <span className="col" style={{ lineHeight: 1.15 }}>
            <span className="label">Repo</span>
            <span className="value mono">acme/billing-engine</span>
          </span>
        </span>

        <span className="ctx-chip" title="Active run">
          <IconBezel tone="cobalt" size="sm" icon="play-circle" />
          <span className="col" style={{ lineHeight: 1.15 }}>
            <span className="label">Active run</span>
            <span className="value">Migrate billing to ledger</span>
          </span>
        </span>

        <span className="ctx-chip" title="Stack health" style={{ cursor: "pointer" }} onClick={onDiagnose}>
          <IconBezel
            tone={stack.overall === "healthy" ? "success" : stack.overall === "warn" ? "warn" : "rose"}
            size="sm"
            icon="circle"
          />
          <span className="col" style={{ lineHeight: 1.15 }}>
            <span className="label">Stack</span>
            <span className="value">{stack.overall === "healthy" ? "Healthy" : stack.overall}</span>
          </span>
        </span>

        <span className="ctx-chip" title="Runtime">
          <span className="col" style={{ lineHeight: 1.15 }}>
            <span className="label">Runtime</span>
            <span className="value mono">{stack.runtime}</span>
          </span>
        </span>
      </div>

      <div className="topbar-actions">
        <Button kind="ghost" size="sm" icon="search" title="Search (⌘K)">
          <span className="kbd">⌘K</span>
        </Button>
        <Button kind="ghost" size="sm" icon="bell" title="Notifications" />
        <Button kind="primary" size="sm" icon="plus" onClick={onOpenSpec}>New spec</Button>
      </div>
    </header>
  );
};

// ---------- Event Drawer -----------------------------------------------
const KIND_TONE = {
  task: "cobalt", review: "violet", approval: "warn", audit: "success",
  artifact: "neutral", error: "rose",
};
const EventDrawer = ({ open, onToggle, events }) => {
  const [filter, setFilter] = useStateShell("all");
  const filtered = events.filter(e => filter === "all" || e.kind === filter);
  return (
    <div className={`drawer${open ? " open" : ""}`}>
      <div className="drawer-handle" onClick={onToggle}>
        <Icon name={open ? "chevron-down" : "chevron-up"} size={14} strokeWidth={1.7} style={{ color: "var(--ink-3)" }} />
        <span style={{ fontWeight: 500, fontSize: 13 }}>Recent events</span>
        <span className="muted" style={{ fontSize: 12.5 }}>· {events.length} in last 24h</span>
        <div className="topbar-spacer" />
        {open ? (
          <div className="filterbar" onClick={(e) => e.stopPropagation()}>
            {["all","task","review","approval","audit","artifact","error"].map(k => (
              <button key={k} className={`filter${filter === k ? " active" : ""}`} onClick={() => setFilter(k)}>
                {k === "all" ? "All" : k[0].toUpperCase() + k.slice(1) + "s"}
              </button>
            ))}
          </div>
        ) : (
          <span className="muted mono" style={{ fontSize: 11.5 }}>
            {events[0] ? rel(events[0].at) + " · " + events[0].body.slice(0, 56) + (events[0].body.length > 56 ? "…" : "") : ""}
          </span>
        )}
      </div>
      {open ? (
        <div className="drawer-body">
          <div className="col gap-2">
            {filtered.map((e, i) => (
              <div key={i} className="row gap-3" style={{ padding: "8px 6px", borderRadius: 10 }}>
                <IconBezel
                  tone={KIND_TONE[e.kind] || "neutral"}
                  size="sm"
                  icon={
                    e.kind === "task" ? "play" :
                    e.kind === "review" ? "shield" :
                    e.kind === "approval" ? "check" :
                    e.kind === "audit" ? "check" :
                    e.kind === "artifact" ? "file" :
                    e.kind === "error" ? "alert" : "dot"
                  }
                />
                <span className="mono" style={{ color: "var(--ink-4)", fontSize: 11.5, width: 60 }}>{rel(e.at)}</span>
                <span className="mono" style={{ color: "var(--ink-3)", fontSize: 12, width: 90 }}>{e.ref}</span>
                <span style={{ fontSize: 13, color: "var(--ink-2)", flex: 1 }}>{e.body}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

// ---------- Inspector --------------------------------------------------
const Inspector = ({ children, onClose, title, subtitle, icon, tone = "neutral" }) => {
  return (
    <aside className="inspector fade-in">
      <div className="inspector-header">
        <IconBezel tone={tone} icon={icon} />
        <div className="flex1 col" style={{ lineHeight: 1.2 }}>
          <div style={{ fontWeight: 600, fontSize: 14.5 }}>{title}</div>
          {subtitle ? <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{subtitle}</div> : null}
        </div>
        <Button kind="ghost" size="sm" icon="x" onClick={onClose} />
      </div>
      <div className="inspector-body">{children}</div>
    </aside>
  );
};

Object.assign(window, { Sidebar, TopBar, EventDrawer, Inspector, NAV_ITEMS });
