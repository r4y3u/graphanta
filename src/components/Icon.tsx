import type { ToolId } from '../types';

interface IconProps {
  name: ToolId | 'undo' | 'redo' | 'save' | 'open' | 'camera' | 'settings' | 'fullscreen' | 'delete' | 'duplicate' | 'chevron' | 'blank' | 'grid' | 'axes' | 'numberLine' | 'tape' | 'measureSegment';
  size?: number;
}

export function Icon({ name, size = 22 }: IconProps) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'select': return <svg {...common}><path d="M5 3l12 8-6 2-2 6z"/><path d="M13 13l5 5"/></svg>;
    case 'zoom': return <svg {...common}><circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L21 21M7 10h6M10 7v6"/></svg>;
    case 'pan': return <svg {...common}><path d="M8 11V6a2 2 0 014 0v4"/><path d="M12 10V5a2 2 0 014 0v6"/><path d="M16 11V8a2 2 0 014 0v6c0 5-3 8-8 8-3 0-5-1-7-4l-2-3a2 2 0 013-3l2 2V8a2 2 0 014 0v3"/></svg>;
    case 'pen': return <svg {...common}><path d="M4 20c3-6 5-9 8-12l4-4a2 2 0 013 3l-4 4c-3 3-6 5-12 8z"/><path d="M13 7l4 4"/></svg>;
    case 'line': return <svg {...common}><path d="M4 19L20 5"/><circle cx="4" cy="19" r="1.5"/><circle cx="20" cy="5" r="1.5"/></svg>;
    case 'arrow': return <svg {...common}><path d="M4 18L20 6"/><path d="M14 6h6v6"/></svg>;
    case 'rectangle': return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="1"/></svg>;
    case 'ellipse': return <svg {...common}><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>;
    case 'polygon': return <svg {...common}><path d="M5 18L3 9l8-5 9 6-3 9z"/></svg>;
    case 'text': return <svg {...common}><path d="M5 5h14M12 5v14M8 19h8"/></svg>;
    case 'math': return <svg {...common}><path d="M5 6h12l-6 6 6 6H5"/><path d="M18 9h2M19 8v2"/></svg>;
    case 'array': return <svg {...common}>{[6,12,18].flatMap((x) => [6,12,18].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6"/>))}</svg>;
    case 'ball': return <svg {...common}><defs><radialGradient id="icon-ball" cx="35%" cy="30%"><stop offset="0" stopColor="currentColor" stopOpacity=".15"/><stop offset=".65" stopColor="currentColor" stopOpacity=".55"/><stop offset="1" stopColor="currentColor" stopOpacity=".9"/></radialGradient></defs><circle cx="12" cy="12" r="7.5" fill="url(#icon-ball)"/><path d="M8 8c1.2-1 2.4-1.4 4-1.4"/></svg>;
    case 'person': return <svg {...common}><circle cx="12" cy="5.2" r="2.2" fill="currentColor" stroke="none"/><path d="M12 8.8v5.4M7.6 11.2h8.8M12 14.2l-3.7 6M12 14.2l3.7 6" strokeWidth="2.5"/></svg>;
    case 'bundle': return <svg {...common}><rect x="3.5" y="6" width="17" height="12" rx="1.5"/><text x="12" y="12.4" textAnchor="middle" dominantBaseline="middle" fontSize="8" fontWeight="750" fill="currentColor" stroke="none">1</text></svg>;
    case 'segment': return <svg {...common}><path d="M3 12h18"/><path d="M4 8v8M9 9v6M15 9v6M20 8v8"/></svg>;
    case 'function': return <svg {...common}><path d="M4 18c4-10 6-13 9-13 4 0 2 14 7 14"/><path d="M4 12h16M12 4v16"/></svg>;
    case 'undo': return <svg {...common}><path d="M9 7L4 12l5 5"/><path d="M5 12h8a6 6 0 016 6"/></svg>;
    case 'redo': return <svg {...common}><path d="M15 7l5 5-5 5"/><path d="M19 12h-8a6 6 0 00-6 6"/></svg>;
    case 'save': return <svg {...common}><path d="M5 4h12l2 2v14H5z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/></svg>;
    case 'open': return <svg {...common}><path d="M3 7h7l2 2h9l-3 10H5z"/><path d="M3 7V5h7l2 2"/></svg>;
    case 'camera': return <svg {...common}><path d="M4 7h4l2-2h4l2 2h4v12H4z"/><circle cx="12" cy="13" r="4"/></svg>;
    case 'settings': return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1l2-1-2-4-2 1a8 8 0 00-2-1l-.3-2H10l-.3 2a8 8 0 00-2 1l-2-1-2 4 2 1a7 7 0 000 2l-2 1 2 4 2-1a8 8 0 002 1l.3 2h4.6l.3-2a8 8 0 002-1l2 1 2-4-2-1a7 7 0 00.1-1z"/></svg>;
    case 'fullscreen': return <svg {...common}><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>;
    case 'delete': return <svg {...common}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>;
    case 'duplicate': return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5H5v11h3"/></svg>;
    case 'chevron': return <svg {...common}><path d="M8 10l4 4 4-4"/></svg>;
    case 'blank': return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2"/></svg>;
    case 'grid': return <svg {...common}><path d="M4 4h16v16H4zM9.33 4v16M14.67 4v16M4 9.33h16M4 14.67h16"/></svg>;
    case 'axes': return <svg {...common}><path d="M3 12h18M12 3v18M18 9l3 3-3 3M9 6l3-3 3 3"/></svg>;
    case 'numberLine': return <svg {...common}><path d="M3 13h18M5 9v8M10 10v6M15 10v6M20 9v8"/><path d="M18 11l3 2-3 2"/></svg>;
    case 'tape': return <svg {...common}><rect x="3" y="7" width="18" height="10" rx="1"/><path d="M11 7v10M16 7v10"/></svg>;
    case 'measureSegment': return <svg {...common}><path d="M3 12h18M3 8v8M12 9v6M21 8v8"/></svg>;
  }
}
