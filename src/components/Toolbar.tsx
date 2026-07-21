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
  { id: 'shapes', members: ['rectangle', 'ellipse', 'polygon'], fallback: 'rectangle' },
  { id: 'writing', members: ['text', 'math'], fallback: 'text' },
];

const GROUP_MEMBER_SET = new Set(GROUPS.flatMap((group) => group.members));
const SINGLE_ORDER: ToolId[] = ['array', 'segment', 'function'];

export function Toolbar({ tools, activeTool, side, onChange }: ToolbarProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [representatives, setRepresentatives] = useState<Record<string, ToolId>>({
    navigation: 'select',
    linework: 'line',
    shapes: 'rectangle',
    writing: 'text',
  });
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    const group = GROUPS.find((item) => item.members.includes(activeTool));
    if (group) setRepresentatives((current) => ({ ...current, [group.id]: activeTool }));
  }, [activeTool]);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  const visible = useMemo(() => new Set(tools), [tools]);
  const groups = GROUPS.map((group) => ({ ...group, members: group.members.filter((tool) => visible.has(tool)) }))
    .filter((group) => group.members.length > 0);
  const singles = SINGLE_ORDER.filter((tool) => visible.has(tool) && !GROUP_MEMBER_SET.has(tool));

  const openGroup = (groupId: string) => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setExpanded(groupId);
  };

  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setExpanded(null), 120);
  };

  const selectFromGroup = (group: ToolGroup, tool: ToolId) => {
    setRepresentatives((current) => ({ ...current, [group.id]: tool }));
    setExpanded(null);
    onChange(tool);
  };

  return (
    <aside className={`toolbar toolbar-${side}`} aria-label="作図ツール">
      {groups.map((group) => {
        const representativeCandidate = representatives[group.id] ?? group.fallback;
        const representative = group.members.includes(representativeCandidate) ? representativeCandidate : group.members[0];
        const isActive = group.members.includes(activeTool);
        return (
          <div
            className="tool-group"
            key={group.id}
            onPointerEnter={() => openGroup(group.id)}
            onPointerLeave={scheduleClose}
            onFocus={() => openGroup(group.id)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose();
            }}
          >
            <button
              className={`tool-button tool-group-main ${isActive ? 'is-active' : ''}`}
              type="button"
              title={TOOL_LABELS[representative]}
              aria-label={TOOL_LABELS[representative]}
              aria-expanded={expanded === group.id}
              onClick={() => onChange(representative)}
            >
              <Icon name={representative} />
              <span className="group-caret">‹</span>
            </button>
            <div className={`tool-flyout flyout-${side} ${expanded === group.id ? 'is-open' : ''}`} role="menu" aria-hidden={expanded !== group.id}>
              {group.members.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  role="menuitem"
                  tabIndex={expanded === group.id ? 0 : -1}
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
