/* global React */
// Simple geometric icon set — primitives only (lines, circles, rects, paths kept simple).

const Icon = ({ name, size = 16, strokeWidth = 1.6, ...rest }) => {
  const s = size;
  const sw = strokeWidth;
  const common = {
    width: s, height: s, viewBox: "0 0 24 24",
    fill: "none", stroke: "currentColor", strokeWidth: sw,
    strokeLinecap: "round", strokeLinejoin: "round",
    ...rest,
  };
  switch (name) {
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
        </svg>
      );
    case "plus":
      return (<svg {...common}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>);
    case "play":
      return (<svg {...common}><path d="M7 5.5 V18.5 L18 12 Z" fill="currentColor" stroke="none" /></svg>);
    case "check":
      return (<svg {...common}><path d="M5 12.5 L10 17.5 L19 7.5" /></svg>);
    case "x":
      return (<svg {...common}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>);
    case "workflow":
      return (
        <svg {...common}>
          <circle cx="5" cy="6" r="2.2" />
          <circle cx="19" cy="6" r="2.2" />
          <circle cx="12" cy="18" r="2.2" />
          <path d="M7 7 L10 16" />
          <path d="M17 7 L14 16" />
        </svg>
      );
    case "stack":
      return (
        <svg {...common}>
          <rect x="3.5" y="4" width="17" height="5" rx="1.4" />
          <rect x="3.5" y="11" width="17" height="5" rx="1.4" />
          <line x1="6" y1="19" x2="18" y2="19" />
        </svg>
      );
    case "settings":
      return (<svg {...common}><circle cx="12" cy="12" r="3.4" /><circle cx="12" cy="12" r="8" /></svg>);
    case "bell":
      return (<svg {...common}><path d="M6 16 V11 a6 6 0 0 1 12 0 V16" /><path d="M4 16 H20" /><path d="M10 19 a2 2 0 0 0 4 0" /></svg>);
    case "chevron-down":
      return (<svg {...common}><path d="M6 9 L12 15 L18 9" /></svg>);
    case "chevron-right":
      return (<svg {...common}><path d="M9 6 L15 12 L9 18" /></svg>);
    case "chevron-up":
      return (<svg {...common}><path d="M6 15 L12 9 L18 15" /></svg>);
    case "search":
      return (<svg {...common}><circle cx="11" cy="11" r="6" /><line x1="20" y1="20" x2="16" y2="16" /></svg>);
    case "branch":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="9" r="2" />
          <path d="M6 8 V16" />
          <path d="M6 12 C 6 9.5 18 12 18 9" />
        </svg>
      );
    case "circle":
      return (<svg {...common}><circle cx="12" cy="12" r="7" /></svg>);
    case "dot":
      return (<svg {...common}><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>);
    case "arrow-right":
      return (<svg {...common}><line x1="5" y1="12" x2="19" y2="12" /><path d="M14 7 L19 12 L14 17" /></svg>);
    case "arrow-up-right":
      return (<svg {...common}><line x1="7" y1="17" x2="17" y2="7" /><path d="M9 7 H17 V15" /></svg>);
    case "file":
      return (<svg {...common}><path d="M6 3.5 H14 L18 7.5 V20 H6 Z" /><path d="M14 3.5 V8 H18" /></svg>);
    case "git-merge":
      return (
        <svg {...common}>
          <circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="12" r="2" />
          <path d="M7 8 V16" />
          <path d="M9 12 H15" />
        </svg>
      );
    case "shield":
      return (<svg {...common}><path d="M12 3.5 L5 6 V12 C5 16 8 19 12 20.5 C16 19 19 16 19 12 V6 Z" /></svg>);
    case "package":
      return (
        <svg {...common}>
          <path d="M4 7.5 L12 4 L20 7.5 V16.5 L12 20 L4 16.5 Z" />
          <path d="M4 7.5 L12 11 L20 7.5" />
          <path d="M12 11 V20" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="15" rx="2" />
          <line x1="4" y1="9" x2="20" y2="9" />
          <line x1="9" y1="3" x2="9" y2="7" />
          <line x1="15" y1="3" x2="15" y2="7" />
        </svg>
      );
    case "filter":
      return (<svg {...common}><path d="M4 5 H20 L14 12 V19 L10 17 V12 Z" /></svg>);
    case "more":
      return (<svg {...common}><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></svg>);
    case "panel-right":
      return (<svg {...common}><rect x="3.5" y="4" width="17" height="16" rx="2" /><line x1="14" y1="4" x2="14" y2="20" /></svg>);
    case "wrench":
      return (
        <svg {...common}>
          <path d="M14 4 a4.5 4.5 0 0 1 5 6 L9 20 L4 15 L14 4Z" />
        </svg>
      );
    case "spark":
      return (<svg {...common}><path d="M12 3 L13.5 10.5 L21 12 L13.5 13.5 L12 21 L10.5 13.5 L3 12 L10.5 10.5 Z" /></svg>);
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11 V8 a4 4 0 0 1 8 0 V11" />
        </svg>
      );
    case "ledger":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <line x1="8" y1="9" x2="16" y2="9" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="12" y2="17" />
        </svg>
      );
    case "play-circle":
      return (<svg {...common}><circle cx="12" cy="12" r="8" /><path d="M10.5 9 L15 12 L10.5 15 Z" fill="currentColor" stroke="none" /></svg>);
    case "approve":
      return (<svg {...common}><circle cx="12" cy="12" r="8" /><path d="M8.5 12.2 L11 14.7 L15.5 9.7" /></svg>);
    case "reject":
      return (<svg {...common}><circle cx="12" cy="12" r="8" /><line x1="9" y1="9" x2="15" y2="15" /><line x1="15" y1="9" x2="9" y2="15" /></svg>);
    case "alert":
      return (<svg {...common}><path d="M12 4 L21 19 H3 Z" /><line x1="12" y1="10" x2="12" y2="14" /><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" /></svg>);
    case "info":
      return (<svg {...common}><circle cx="12" cy="12" r="8" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="8.5" r="0.6" fill="currentColor" stroke="none" /></svg>);
    case "menu":
      return (<svg {...common}><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg>);
    default:
      return (<svg {...common}><circle cx="12" cy="12" r="2" /></svg>);
  }
};

window.Icon = Icon;
