import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

interface TouchGesture {
  pointerId: number;
  groupId: string;
  candidate: ToolId;
  startX: number;
  startY: number;
}

interface FlyoutPosition {
  left: number;
  top: number;
}

const GROUPS: ToolGroup[] = [
  { id: 'navigation', members: ['select', 'pan', 'zoom'], fallback: 'select' },
  { id: 'linework', members: ['line', 'arrow', 'pen'], fallback: 'line' },
  { id: 'shapes', members: ['rectangle', 'ellipse', 'polygon'], fallback: 'rectangle' },
  { id: 'writing', members: ['text', 'math'], fallback: 'text' },
  { id: 'arrays', members: ['array', 'ball', 'person', 'bundle'], fallback: 'array' },
];

const GROUP_MEMBER_SET = new Set(GROUPS.flatMap((group) => group.members));
const SINGLE_ORDER: ToolId[] = ['segment', 'function'];

export function Toolbar({ tools, activeTool, side, onChange }: ToolbarProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [touchGesture, setTouchGesture] = useState<TouchGesture | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState<FlyoutPosition | null>(null);
  const [representatives, setRepresentatives] = useState<Record<string, ToolId>>({
    navigation: 'select',
    linework: 'line',
    shapes: 'rectangle',
    writing: 'text',
    arrays: 'array',
  });
  const closeTimer = useRef<number | null>(null);
  const gestureRef = useRef<TouchGesture | null>(null);
  const suppressClickRef = useRef(false);
  const suppressTimer = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const groupButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const group = GROUPS.find((item) => item.members.includes(activeTool));
    if (group) setRepresentatives((current) => ({ ...current, [group.id]: activeTool }));
  }, [activeTool]);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
  }, []);

  const visible = useMemo(() => new Set(tools), [tools]);
  const groups = GROUPS.map((group) => ({ ...group, members: group.members.filter((tool) => visible.has(tool)) }))
    .filter((group) => group.members.length > 0);
  const singles = SINGLE_ORDER.filter((tool) => visible.has(tool) && !GROUP_MEMBER_SET.has(tool));

  useLayoutEffect(() => {
    if (!expanded) {
      setFlyoutPosition(null);
      return undefined;
    }

    const positionFlyout = () => {
      const button = groupButtonRefs.current[expanded];
      const flyout = flyoutRef.current;
      if (!button || !flyout) return;

      const buttonRect = button.getBoundingClientRect();
      const flyoutRect = flyout.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 8;
      const desiredLeft = side === 'right'
        ? buttonRect.left - flyoutRect.width - gap
        : buttonRect.right + gap;
      const left = Math.min(
        Math.max(viewportPadding, desiredLeft),
        Math.max(viewportPadding, window.innerWidth - flyoutRect.width - viewportPadding),
      );
      const top = Math.min(
        Math.max(viewportPadding, buttonRect.top),
        Math.max(viewportPadding, window.innerHeight - flyoutRect.height - viewportPadding),
      );

      setFlyoutPosition((current) => (
        current?.left === left && current.top === top ? current : { left, top }
      ));
    };

    positionFlyout();
    const toolbar = toolbarRef.current;
    toolbar?.addEventListener('scroll', positionFlyout, { passive: true });
    window.addEventListener('resize', positionFlyout);
    return () => {
      toolbar?.removeEventListener('scroll', positionFlyout);
      window.removeEventListener('resize', positionFlyout);
    };
  }, [expanded, side, tools]);

  const openGroup = (groupId: string) => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setExpanded(groupId);
  };

  const scheduleClose = () => {
    if (gestureRef.current) return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setExpanded(null), 120);
  };

  const selectFromGroup = (group: ToolGroup, tool: ToolId) => {
    setRepresentatives((current) => ({ ...current, [group.id]: tool }));
    setExpanded(null);
    onChange(tool);
  };

  const setGesture = (gesture: TouchGesture | null) => {
    gestureRef.current = gesture;
    setTouchGesture(gesture);
  };

  const toolUnderPointer = (group: ToolGroup, clientX: number, clientY: number): ToolId | null => {
    const target = document.elementFromPoint(clientX, clientY);
    const button = target?.closest<HTMLButtonElement>(`[data-toolbar-group="${group.id}"][data-tool]`);
    const tool = button?.dataset.tool as ToolId | undefined;
    return tool && group.members.includes(tool) ? tool : null;
  };

  const beginTouchGesture = (
    event: React.PointerEvent<HTMLButtonElement>,
    group: ToolGroup,
    representative: ToolId,
  ) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer captureが使えない環境でも、通常のpointerイベントで継続する。
    }
    const gesture = {
      pointerId: event.pointerId,
      groupId: group.id,
      candidate: representative,
      startX: event.clientX,
      startY: event.clientY,
    };
    setGesture(gesture);
    setExpanded(group.id);
  };

  const updateTouchGesture = (event: React.PointerEvent<HTMLButtonElement>, group: ToolGroup) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.groupId !== group.id) return;
    const horizontalDistance = Math.abs(event.clientX - gesture.startX);
    const verticalDistance = Math.abs(event.clientY - gesture.startY);
    if (verticalDistance > 8 && verticalDistance > horizontalDistance) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // ブラウザがスクロールを開始してcaptureを解除済みなら何もしない。
      }
      setGesture(null);
      setExpanded(null);
      suppressClickRef.current = true;
      if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
      suppressTimer.current = window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 360);
      return;
    }
    if (horizontalDistance > 4) event.preventDefault();
    const candidate = toolUnderPointer(group, event.clientX, event.clientY);
    if (candidate && candidate !== gesture.candidate) setGesture({ ...gesture, candidate });
  };

  const finishTouchGesture = (
    event: React.PointerEvent<HTMLButtonElement>,
    group: ToolGroup,
    cancelled = false,
  ) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.groupId !== group.id) return;
    event.preventDefault();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 既にcaptureが解除されている場合は何もしない。
    }

    const candidate = toolUnderPointer(group, event.clientX, event.clientY) ?? gesture.candidate;
    setGesture(null);
    setExpanded(null);

    // pointerup後に生成される互換clickで代表ツールへ戻らないよう抑止する。
    suppressClickRef.current = true;
    if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
    suppressTimer.current = window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 360);

    if (!cancelled) selectFromGroup(group, candidate);
  };

  return (
    <aside ref={toolbarRef} className={`toolbar toolbar-${side}`} aria-label="作図ツール">
      {groups.map((group) => {
        const representativeCandidate = representatives[group.id] ?? group.fallback;
        const representative = group.members.includes(representativeCandidate) ? representativeCandidate : group.members[0];
        const isActive = group.members.includes(activeTool);
        const isGestureGroup = touchGesture?.groupId === group.id;
        return (
          <div
            className={`tool-group ${isGestureGroup ? 'is-touch-gesture' : ''}`}
            key={group.id}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') openGroup(group.id);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') scheduleClose();
            }}
            onFocus={() => openGroup(group.id)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose();
            }}
          >
            <button
              ref={(node) => {
                groupButtonRefs.current[group.id] = node;
              }}
              className={`tool-button tool-group-main ${isActive ? 'is-active' : ''} ${isGestureGroup ? 'is-pressed' : ''}`}
              type="button"
              title={TOOL_LABELS[representative]}
              aria-label={`${TOOL_LABELS[representative]}。タッチでは押したまま移動してグループ内のツールを選択できます`}
              aria-expanded={expanded === group.id}
              onPointerDown={(event) => beginTouchGesture(event, group, representative)}
              onPointerMove={(event) => updateTouchGesture(event, group)}
              onPointerUp={(event) => finishTouchGesture(event, group)}
              onPointerCancel={(event) => finishTouchGesture(event, group, true)}
              onClick={(event) => {
                if (suppressClickRef.current) {
                  event.preventDefault();
                  return;
                }
                onChange(representative);
              }}
            >
              <Icon name={representative} />
              <span className="group-caret">‹</span>
            </button>
            {expanded === group.id && typeof document !== 'undefined' && createPortal(
              <div
                ref={flyoutRef}
                className={`tool-flyout toolbar-flyout-portal flyout-${side} is-open ${isGestureGroup ? 'is-gesture-open' : ''}`}
                role="menu"
                style={{
                  left: flyoutPosition?.left ?? 0,
                  top: flyoutPosition?.top ?? 0,
                  visibility: flyoutPosition ? undefined : 'hidden',
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') openGroup(group.id);
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === 'mouse') scheduleClose();
                }}
                onFocus={() => openGroup(group.id)}
              >
                {group.members.map((tool) => {
                  const isDragTarget = isGestureGroup && touchGesture?.candidate === tool;
                  return (
                    <button
                      key={tool}
                      type="button"
                      role="menuitem"
                      data-toolbar-group={group.id}
                      data-tool={tool}
                      className={`tool-flyout-button ${activeTool === tool ? 'is-active' : ''} ${isDragTarget ? 'is-drag-target' : ''}`}
                      title={TOOL_LABELS[tool]}
                      aria-label={TOOL_LABELS[tool]}
                      onClick={() => selectFromGroup(group, tool)}
                    >
                      <Icon name={tool} />
                      <span>{TOOL_LABELS[tool]}</span>
                    </button>
                  );
                })}
              </div>,
              document.body,
            )}
          </div>
        );
      })}

      {singles.map((tool) => {
        return (
          <button
            key={tool}
            className={`tool-button ${activeTool === tool ? 'is-active' : ''}`}
            type="button"
            title={TOOL_LABELS[tool]}
            aria-label={TOOL_LABELS[tool]}
            onClick={() => onChange(tool)}
          >
            <Icon name={tool} />
          </button>
        );
      })}
    </aside>
  );
}
