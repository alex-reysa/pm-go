/* global React */
const { useState, useEffect, useRef, useMemo } = React;

// ---------- IconBezel ---------------------------------------------------
const IconBezel = ({ tone = "neutral", size = "md", icon, children }) => {
  const cls = `iconbezel tone-${tone} ${size === "sm" ? "sm" : size === "lg" ? "lg" : size === "xl" ? "xl" : ""}`;
  const iconSize = size === "sm" ? 13 : size === "lg" ? 19 : size === "xl" ? 24 : 16;
  return (
    <span className={cls}>
      {children || (icon ? <Icon name={icon} size={iconSize} strokeWidth={1.7} /> : null)}
    </span>
  );
};

// ---------- Button ------------------------------------------------------
const Button = ({ kind = "subtle", size, icon, iconRight, children, onClick, disabled, title }) => {
  return (
    <button
      className={`btn ${kind} ${size || ""}`.trim()}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon ? <Icon name={icon} size={size === "sm" ? 13 : 14} strokeWidth={1.7} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={size === "sm" ? 13 : 14} strokeWidth={1.7} /> : null}
    </button>
  );
};

// ---------- Chip --------------------------------------------------------
const Chip = ({ tone = "neutral", dot, mono, children }) => (
  <span className={`chip ${tone}${mono ? " mono" : ""}`}>
    {dot ? <span className="dot" /> : null}
    {children}
  </span>
);

// ---------- Status helpers ---------------------------------------------
const STATUS_META = {
  ready:           { tone: "neutral", label: "Ready",          cls: "ready" },
  running:         { tone: "cobalt",  label: "Running",        cls: "running" },
  in_review:       { tone: "violet",  label: "In review",      cls: "review" },
  review:          { tone: "violet",  label: "In review",      cls: "review" },
  fixing:          { tone: "warn",    label: "Fixing",         cls: "fixing" },
  blocked:         { tone: "warn",    label: "Blocked",        cls: "blocked" },
  merged:          { tone: "success", label: "Ready to merge", cls: "merged" },
  ready_to_merge:  { tone: "success", label: "Ready to merge", cls: "merged" },
  failed:          { tone: "rose",    label: "Failed",         cls: "failed" },
  released:        { tone: "success", label: "Released",       cls: "merged" },
  done:            { tone: "success", label: "Done",           cls: "merged" },
  active:          { tone: "cobalt",  label: "Active",         cls: "running" },
  queued:          { tone: "neutral", label: "Queued",         cls: "ready" },
};
const StatusChip = ({ status }) => {
  const m = STATUS_META[status] || STATUS_META.ready;
  return <Chip tone={m.tone} dot>{m.label}</Chip>;
};
const StatusDot = ({ status }) => {
  const m = STATUS_META[status] || STATUS_META.ready;
  return <span className={`statusdot ${m.cls}`} />;
};

// ---------- Field row (inspector) --------------------------------------
const FieldRow = ({ label, children }) => (
  <div className="field-row">
    <div className="label">{label}</div>
    <div className="value">{children}</div>
  </div>
);

// ---------- Card --------------------------------------------------------
const Card = ({ title, action, children, padding, className = "" }) => (
  <div className={`card ${className}`} style={padding ? { padding } : undefined}>
    {(title || action) ? (
      <div className="card-header">
        <h3 className="h3">{title}</h3>
        {action ? <div>{action}</div> : null}
      </div>
    ) : null}
    {children}
  </div>
);

// ---------- Relative time ----------------------------------------------
function rel(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff/60)}m ago`;
  if (diff < 86400) return `${Math.round(diff/3600)}h ago`;
  return `${Math.round(diff/86400)}d ago`;
}

// ---------- Tiny progress bar ------------------------------------------
const ProgressBar = ({ value, max, green }) => {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className={`bar${green ? " green" : ""}`}><span style={{ width: `${pct}%` }} /></div>
  );
};

Object.assign(window, {
  IconBezel, Button, Chip, StatusChip, StatusDot, STATUS_META,
  FieldRow, Card, ProgressBar, rel,
});
