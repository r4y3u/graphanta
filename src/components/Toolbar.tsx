import { useEffect, useMemo, useRef, useState } from 'react';
import { TOOL_LABELS } from '../defaults';
import type { ToolId } from '../types';
import { Icon } from './Icon';

interface ToolbarProps {
  tools: ToolId[];
  activeTool: ToolId;
  side: 'left' | 'right';
  onChange: (tool: ToolId) => void;
}

interface ToolGroup {
  id: string;
  members: ToolId[];
  fallback: ToolId;
}

const GROUPS: ToolGroup[] = [
  { id: 'navigation', members: ['select', 'pan', 'zoom'], fallback: 'select' },
  { id: 'linework', members: ['line', 'arrow', 'pen'], fallback: 'line' },
  { id: 'shapes', members: ['rectangle', 'ellipse'], fallback: 'rectangle' },
  { id: 'writing', members: ['text', 'math'], fallback: 'text' },
];

const GROUP_MEMBER_SET = new Set(GROUPS.flatMap((group) => group.members));
const SINGLE_ORDER: ToolId[] = ['polygon', 'array', 'segment', 'function'];

export function Toolbar({ tools, activeTool, side, onChange }: ToolbarProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [representatives, setRepresentatives] = useState<Record<string, ToolId>>({
    navigation: 'select',
    linework: 'line',
    shapes: 'rectangle',
    writing: 'text',
  });
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const group = GROUPS.find((item) => item.members.includes(activeTool));
    if (group) setRepresentatives((current) => ({ ...current, [group.id]: activeTool }));
  }, [activeTool]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const visible = useMemo(() => new Set(tools), [tools]);
  const groups = GROUPS.map((group) => ({ ...group, members: group.members.filter((tool) => visible.has(tool)) }))
    .filter((group) => group.members.length > 0);
  const singles = SINGLE_ORDER.filter((tool) => visible.has(tool) && !GROUP_MEMBER_SET.has(tool));

  const selectFromGroup = (group: ToolGroup, tool: ToolId) => {
    setRepresentatives((current) => ({ ...current, [group.id]: tool }));
    setExpanded(null);
    onChange(tool);
  };

  return (
    <aside ref={rootRef} className={`toolbar toolbar-${side}`} aria-label="作図ツール">
      {groups.map((group) => {
        const representativeCandidate = representatives[group.id] ?? group.fallback;
        const representative = group.members.includes(representativeCandidate) ? representativeCandidate : group.members[0];
        const isActive = group.members.includes(activeTool);
        return (
          <div className="tool-group" key={group.id}>
            <button
              className={`tool-button tool-group-main ${isActive ? 'is-active' : ''}`}
              type="button"
              title={`${TOOL_LABELS[representative]}（長押し・再クリックで展開）`}
              aria-label={`${TOOL_LABELS[representative]}グループ`}
              aria-expanded={expanded === group.id}
              onClick={() => setExpanded((current) => current === group.id ? null : group.id)}
            >
              <Icon name={representative} />
              <span className="group-caret">›</span>
            </button>
            {expanded === group.id && (
              <div className={`tool-flyout flyout-${side}`} role="menu">
                {group.members.map((tool) => (
                  <button
                    key={tool}
                    type="button"
                    role="menuitem"
                    className={`tool-flyout-button ${activeTool === tool ? 'is-active' : ''}`}
                    title={TOOL_LABELS[tool]}
                    aria-label={TOOL_LABELS[tool]}
                    onClick={() => selectFromGroup(group, tool)}
                  >
                    <Icon name={tool} />
                    <span>{TOOL_LABELS[tool]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {singles.map((tool) => {
        const disabled = tool === 'function';
        return (
          <button
            key={tool}
            className={`tool-button ${activeTool === tool ? 'is-active' : ''}`}
            type="button"
            title={TOOL_LABELS[tool]}
            aria-label={TOOL_LABELS[tool]}
            disabled={disabled}
            onClick={() => onChange(tool)}
          >
            <Icon name={tool} />
            {disabled && <span className="tool-badge">v3</span>}
          </button>
        );
      })}
    </aside>
  );
}
