import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { ALL_TOOLS, APP_VERSION, TOOL_LABELS, createDefaultSettings, createInitialProject } from './defaults';
import { Icon } from './components/Icon';
import { Modal } from './components/Modal';
import { Toolbar } from './components/Toolbar';
import { createId, normalizeRect, pointsToPath, snapPoint, translateObject } from './lib/geometry';
import { prettyMath, resolveNumber } from './lib/math';
import { openSvgAsPng } from './lib/screenshot';
import {
  downloadJson,
  loadAutosave,
  loadSettingsLocal,
  readJsonFile,
  saveAutosave,
  saveSettingsLocal,
} from './lib/storage';
import type {
  ArrayObject,
  ExpressionDef,
  GraphicObject,
  GraphantaProject,
  GraphantaSettings,
  MathObject,
  Point,
  SegmentObject,
  TextObject,
  ToolId,
  VariableDef,
} from './types';

interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

type Interaction =
  | { kind: 'draw'; objectId: string; start: Point }
  | { kind: 'move'; objectId: string; start: Point; original: GraphicObject }
  | { kind: 'pan'; clientStart: Point; originalView: ViewState }
  | null;

type ModalState =
  | { kind: 'settings' }
  | { kind: 'text'; point: Point; value: string }
  | { kind: 'math'; point: Point; value: string; expressionId?: string }
  | { kind: 'about' }
  | null;

const MIN_DRAW_SIZE = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isProject(value: unknown): value is GraphantaProject {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GraphantaProject>;
  return candidate.format === 'graphanta-project' && candidate.schemaVersion === 1 && Array.isArray(candidate.objects);
}

function isSettings(value: unknown): value is GraphantaSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GraphantaSettings>;
  return candidate.format === 'graphanta-settings' && candidate.schemaVersion === 1 && Array.isArray(candidate.visibleTools);
}

function getObjectBounds(object: GraphicObject, variables: VariableDef[]): { x: number; y: number; width: number; height: number } {
  switch (object.type) {
    case 'pen':
    case 'polygon': {
      const xs = object.points.map((point) => point.x);
      const ys = object.points.map((point) => point.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
    }
    case 'line':
    case 'arrow':
    case 'segment':
      return normalizeRect(object.start, object.end);
    case 'rectangle':
    case 'array':
      return { x: object.x, y: object.y, width: object.width, height: object.height };
    case 'ellipse':
      return { x: object.cx - object.rx, y: object.cy - object.ry, width: object.rx * 2, height: object.ry * 2 };
    case 'text':
      return { x: object.x - 4, y: object.y - object.fontSize, width: Math.max(30, object.text.length * object.fontSize * 0.62), height: object.fontSize * 1.3 };
    case 'math':
      return { x: object.x - 4, y: object.y - object.fontSize, width: Math.max(40, prettyMath(object.expression).length * object.fontSize * 0.62), height: object.fontSize * 1.3 };
  }
}

function App() {
  const [project, setProject] = useState<GraphantaProject>(() => createInitialProject());
  const [settings, setSettings] = useState<GraphantaSettings>(() => loadSettingsLocal() ?? createDefaultSettings());
  const [activeTool, setActiveTool] = useState<ToolId>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, zoom: 1 });
  const [interaction, setInteraction] = useState<Interaction>(null);
  const [polygonPoints, setPolygonPoints] = useState<Point[]>([]);
  const [panelCollapsed, setPanelCollapsed] = useState({ tweak: false, expressions: false });
  const [modal, setModal] = useState<ModalState>(null);
  const [presentation, setPresentation] = useState(false);
  const [status, setStatus] = useState('準備完了');
  const [restored, setRestored] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const settingsInputRef = useRef<HTMLInputElement | null>(null);
  const undoStack = useRef<GraphantaProject[]>([]);
  const redoStack = useRef<GraphantaProject[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);

  const selectedObject = useMemo(
    () => project.objects.find((object) => object.id === selectedId) ?? null,
    [project.objects, selectedId],
  );

  const visibleTools = useMemo(
    () => settings.visibleTools.filter((tool) => ALL_TOOLS.includes(tool)),
    [settings.visibleTools],
  );

  const commitHistory = useCallback((snapshot: GraphantaProject = project) => {
    undoStack.current.push(structuredClone(snapshot));
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
    setHistoryRevision((revision) => revision + 1);
  }, [project]);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(structuredClone(project));
    setProject(previous);
    setSelectedId(null);
    setHistoryRevision((revision) => revision + 1);
    setStatus('元に戻しました');
  }, [project]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(structuredClone(project));
    setProject(next);
    setSelectedId(null);
    setHistoryRevision((revision) => revision + 1);
    setStatus('やり直しました');
  }, [project]);

  const mutateProject = useCallback((updater: (current: GraphantaProject) => GraphantaProject, addHistory = true) => {
    setProject((current) => {
      if (addHistory) {
        undoStack.current.push(structuredClone(current));
        if (undoStack.current.length > 100) undoStack.current.shift();
        redoStack.current = [];
        setHistoryRevision((revision) => revision + 1);
      }
      const next = updater(current);
      return { ...next, appVersion: APP_VERSION, updatedAt: new Date().toISOString() };
    });
  }, []);

  const updateObject = useCallback((id: string, updater: (object: GraphicObject) => GraphicObject, addHistory = true) => {
    mutateProject((current) => ({
      ...current,
      objects: current.objects.map((object) => (object.id === id ? updater(object) : object)),
    }), addHistory);
  }, [mutateProject]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    mutateProject((current) => ({ ...current, objects: current.objects.filter((object) => object.id !== selectedId) }));
    setSelectedId(null);
    setStatus('選択した要素を削除しました');
  }, [mutateProject, selectedId]);

  const duplicateSelected = useCallback(() => {
    if (!selectedObject) return;
    const duplicate = translateObject({ ...structuredClone(selectedObject), id: createId(selectedObject.type) }, 20, 20);
    mutateProject((current) => ({ ...current, objects: [...current.objects, duplicate] }));
    setSelectedId(duplicate.id);
    setStatus('選択した要素を複製しました');
  }, [mutateProject, selectedObject]);

  useEffect(() => {
    saveSettingsLocal(settings);
  }, [settings]);

  useEffect(() => {
    if (restored || !settings.autoRestore) return;
    setRestored(true);
    loadAutosave()
      .then((saved) => {
        if (!saved || saved.objects.length === 0) return;
        if (window.confirm('前回の作業を復元しますか？')) {
          setProject(saved);
          setStatus('前回の作業を復元しました');
        }
      })
      .catch(() => setStatus('自動復旧データを確認できませんでした'));
  }, [restored, settings.autoRestore]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveAutosave(project).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [project]);

  useEffect(() => {
    const onFullscreen = () => setPresentation(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
      } else if (event.key === 'Escape') {
        setPolygonPoints([]);
        setInteraction(null);
        setModal(null);
        setSelectedId(null);
      } else if (event.key === 'Enter' && polygonPoints.length >= 3) {
        event.preventDefault();
        finalizePolygon();
      } else if (selectedObject && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0;
        const dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
        updateObject(selectedObject.id, (object) => translateObject(object, dx, dy));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelected, polygonPoints.length, redo, selectedObject, undo, updateObject]);

  const worldPoint = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const inverse = svg.getScreenCTM()?.inverse();
    const transformed = inverse ? point.matrixTransform(inverse) : point;
    return snapPoint({ x: transformed.x, y: transformed.y }, project.canvas.gridSize, project.canvas.snapGrid);
  }, [project.canvas.gridSize, project.canvas.snapGrid]);

  function defaultStyle() {
    return {
      stroke: settings.defaultStroke,
      fill: settings.defaultFill,
      strokeWidth: settings.defaultStrokeWidth,
      opacity: 1,
    };
  }

  const createDrawObject = useCallback((tool: ToolId, point: Point): GraphicObject | null => {
    const style = defaultStyle();
    switch (tool) {
      case 'pen':
        return { id: createId('pen'), type: 'pen', points: [point], ...style };
      case 'line':
      case 'arrow':
        return { id: createId(tool), type: tool, start: point, end: point, ...style };
      case 'rectangle':
        return { id: createId('rectangle'), type: 'rectangle', x: point.x, y: point.y, width: 0, height: 0, radius: 0, ...style };
      case 'ellipse':
        return { id: createId('ellipse'), type: 'ellipse', cx: point.x, cy: point.y, rx: 0, ry: 0, ...style };
      case 'array':
        return {
          id: createId('array'), type: 'array', x: point.x, y: point.y, width: 0, height: 0,
          rowsExpr: '3', colsExpr: '4', symbol: 'circle', symbolSize: 9, ...style,
        };
      case 'segment':
        return {
          id: createId('segment'), type: 'segment', start: point, end: point,
          ticksExpr: '4', startValueExpr: '0', endValueExpr: '4', showValues: true, ...style,
        };
      default:
        return null;
    }
  }, [settings.defaultFill, settings.defaultStroke, settings.defaultStrokeWidth]);

  function beginPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    const objectElement = target.closest('[data-object-id]');
    const objectId = objectElement?.getAttribute('data-object-id') ?? null;

    if (activeTool === 'pan') {
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({
        kind: 'pan',
        clientStart: { x: event.clientX, y: event.clientY },
        originalView: view,
      });
      return;
    }

    const point = worldPoint(event.clientX, event.clientY);

    if (activeTool === 'select') {
      if (!objectId) {
        setSelectedId(null);
        return;
      }
      const object = project.objects.find((item) => item.id === objectId);
      if (!object || object.locked) return;
      commitHistory(project);
      setSelectedId(objectId);
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({ kind: 'move', objectId, start: point, original: structuredClone(object) });
      return;
    }

    if (activeTool === 'text') {
      setModal({ kind: 'text', point, value: '' });
      return;
    }

    if (activeTool === 'math') {
      setModal({ kind: 'math', point, value: '' });
      return;
    }

    if (activeTool === 'polygon') {
      setPolygonPoints((points) => [...points, point]);
      setStatus('多角形: 頂点を追加中。Enterで確定、Escで中止');
      return;
    }

    const object = createDrawObject(activeTool, point);
    if (!object) return;
    commitHistory(project);
    setProject((current) => ({ ...current, objects: [...current.objects, object], updatedAt: new Date().toISOString() }));
    setSelectedId(object.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    setInteraction({ kind: 'draw', objectId: object.id, start: point });
  }

  function movePointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (!interaction) return;
    if (interaction.kind === 'pan') {
      const rect = event.currentTarget.getBoundingClientRect();
      const worldWidth = project.canvas.width / interaction.originalView.zoom;
      const worldHeight = project.canvas.height / interaction.originalView.zoom;
      const dx = ((event.clientX - interaction.clientStart.x) / Math.max(1, rect.width)) * worldWidth;
      const dy = ((event.clientY - interaction.clientStart.y) / Math.max(1, rect.height)) * worldHeight;
      setView({ ...interaction.originalView, x: interaction.originalView.x - dx, y: interaction.originalView.y - dy });
      return;
    }

    const point = worldPoint(event.clientX, event.clientY);
    if (interaction.kind === 'move') {
      const dx = point.x - interaction.start.x;
      const dy = point.y - interaction.start.y;
      updateObject(interaction.objectId, () => translateObject(interaction.original, dx, dy), false);
      return;
    }

    updateObject(interaction.objectId, (object) => {
      switch (object.type) {
        case 'pen':
          return { ...object, points: [...object.points, point] };
        case 'line':
        case 'arrow':
        case 'segment':
          return { ...object, end: point };
        case 'rectangle': {
          const rect = normalizeRect(interaction.start, point);
          return { ...object, ...rect };
        }
        case 'ellipse':
          return { ...object, cx: interaction.start.x, cy: interaction.start.y, rx: Math.abs(point.x - interaction.start.x), ry: Math.abs(point.y - interaction.start.y) };
        case 'array': {
          const rect = normalizeRect(interaction.start, point);
          return { ...object, ...rect };
        }
        default:
          return object;
      }
    }, false);
  }

  function endPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (!interaction) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (interaction.kind === 'draw') {
      const object = project.objects.find((item) => item.id === interaction.objectId);
      if (object) {
        const bounds = getObjectBounds(object, project.variables);
        if (bounds.width < MIN_DRAW_SIZE && bounds.height < MIN_DRAW_SIZE && object.type !== 'pen') {
          setProject((current) => ({ ...current, objects: current.objects.filter((item) => item.id !== object.id) }));
          setSelectedId(null);
        }
      }
    }
    setInteraction(null);
  }

  function onWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const point = worldPoint(event.clientX, event.clientY);
    const oldZoom = view.zoom;
    const nextZoom = clamp(oldZoom * (event.deltaY < 0 ? 1.12 : 0.89), 0.25, 5);
    const widthOld = project.canvas.width / oldZoom;
    const heightOld = project.canvas.height / oldZoom;
    const ratioX = (point.x - view.x) / widthOld;
    const ratioY = (point.y - view.y) / heightOld;
    const widthNew = project.canvas.width / nextZoom;
    const heightNew = project.canvas.height / nextZoom;
    setView({ x: point.x - ratioX * widthNew, y: point.y - ratioY * heightNew, zoom: nextZoom });
  }

  function finalizePolygon() {
    if (polygonPoints.length < 3) return;
    const object: GraphicObject = {
      id: createId('polygon'),
      type: 'polygon',
      points: polygonPoints,
      ...defaultStyle(),
    };
    mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelectedId(object.id);
    setPolygonPoints([]);
    setStatus('多角形を作成しました');
  }

  function addText(value: string, point: Point) {
    if (!value.trim()) return;
    const object: TextObject = {
      id: createId('text'), type: 'text', x: point.x, y: point.y,
      text: value.trim(), fontSize: 28, fontWeight: 500, align: 'start', ...defaultStyle(),
    };
    mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelectedId(object.id);
  }

  function addMath(value: string, point: Point) {
    if (!value.trim()) return;
    const object: MathObject = {
      id: createId('math'), type: 'math', x: point.x, y: point.y,
      expression: value.trim(), fontSize: 30, ...defaultStyle(),
    };
    mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelectedId(object.id);
  }

  function renderArray(object: ArrayObject) {
    const rows = clamp(Math.round(resolveNumber(object.rowsExpr, project.variables, 3)), 1, 50);
    const cols = clamp(Math.round(resolveNumber(object.colsExpr, project.variables, 4)), 1, 50);
    const cellWidth = object.width / cols;
    const cellHeight = object.height / rows;
    const symbolSize = Math.min(object.symbolSize, cellWidth * 0.36, cellHeight * 0.36);
    const symbols = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cx = object.x + cellWidth * (col + 0.5);
        const cy = object.y + cellHeight * (row + 0.5);
        if (object.symbol === 'circle') {
          symbols.push(<circle key={`${row}-${col}`} cx={cx} cy={cy} r={symbolSize} fill={object.fill === 'transparent' ? object.stroke : object.fill} stroke="none" />);
        } else if (object.symbol === 'square') {
          symbols.push(<rect key={`${row}-${col}`} x={cx - symbolSize} y={cy - symbolSize} width={symbolSize * 2} height={symbolSize * 2} fill={object.fill === 'transparent' ? object.stroke : object.fill} stroke="none" />);
        } else if (object.symbol === 'dot') {
          symbols.push(<circle key={`${row}-${col}`} cx={cx} cy={cy} r={Math.max(2, symbolSize * 0.42)} fill={object.stroke} stroke="none" />);
        } else {
          symbols.push(<path key={`${row}-${col}`} d={`M ${cx - symbolSize} ${cy - symbolSize} L ${cx + symbolSize} ${cy + symbolSize} M ${cx + symbolSize} ${cy - symbolSize} L ${cx - symbolSize} ${cy + symbolSize}`} fill="none" stroke={object.stroke} strokeWidth={object.strokeWidth} />);
        }
      }
    }
    return symbols;
  }

  function renderSegment(object: SegmentObject) {
    const intervals = clamp(Math.round(resolveNumber(object.ticksExpr, project.variables, 4)), 1, 50);
    const startValue = resolveNumber(object.startValueExpr, project.variables, 0);
    const endValue = resolveNumber(object.endValueExpr, project.variables, intervals);
    const dx = object.end.x - object.start.x;
    const dy = object.end.y - object.start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const normal = { x: -dy / length, y: dx / length };
    const ticks = [];
    for (let index = 0; index <= intervals; index += 1) {
      const ratio = index / intervals;
      const x = object.start.x + dx * ratio;
      const y = object.start.y + dy * ratio;
      const major = index === 0 || index === intervals;
      const half = major ? 11 : 7;
      ticks.push(
        <g key={index}>
          <line x1={x - normal.x * half} y1={y - normal.y * half} x2={x + normal.x * half} y2={y + normal.y * half} />
          {object.showValues && (
            <text x={x + normal.x * 25} y={y + normal.y * 25} textAnchor="middle" dominantBaseline="middle" fontSize={16} fill={object.stroke} stroke="none">
              {Number((startValue + (endValue - startValue) * ratio).toFixed(4))}
            </text>
          )}
        </g>,
      );
    }
    return ticks;
  }

  function renderObject(object: GraphicObject) {
    if (object.hidden) return null;
    const common = {
      stroke: object.stroke,
      fill: object.fill,
      strokeWidth: object.strokeWidth,
      opacity: object.opacity,
      vectorEffect: 'non-scaling-stroke' as const,
    };
    const hitStroke = Math.max(14 / view.zoom, object.strokeWidth * 4);
    const content = (() => {
      switch (object.type) {
        case 'pen':
          return <path d={pointsToPath(object.points)} {...common} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
        case 'line':
          return <line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} {...common} fill="none" />;
        case 'arrow':
          return <line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} {...common} fill="none" markerEnd="url(#arrowhead)" />;
        case 'rectangle':
          return <rect x={object.x} y={object.y} width={object.width} height={object.height} rx={object.radius} {...common} />;
        case 'ellipse':
          return <ellipse cx={object.cx} cy={object.cy} rx={object.rx} ry={object.ry} {...common} />;
        case 'polygon':
          return <polygon points={object.points.map((point) => `${point.x},${point.y}`).join(' ')} {...common} />;
        case 'text':
          return <text x={object.x} y={object.y} fontSize={object.fontSize} fontWeight={object.fontWeight} textAnchor={object.align} fill={object.stroke} stroke="none" opacity={object.opacity}>{object.text}</text>;
        case 'math':
          return <text x={object.x} y={object.y} fontSize={object.fontSize} fontFamily="Georgia, 'Times New Roman', serif" fontStyle="italic" fill={object.stroke} stroke="none" opacity={object.opacity}>{prettyMath(object.expression)}</text>;
        case 'array':
          return <g opacity={object.opacity}>{renderArray(object)}</g>;
        case 'segment':
          return <g {...common} fill="none"><line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} />{renderSegment(object)}</g>;
      }
    })();

    const hit = (() => {
      switch (object.type) {
        case 'line':
        case 'arrow':
        case 'segment':
          return <line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} stroke="transparent" strokeWidth={hitStroke} />;
        case 'pen':
          return <path d={pointsToPath(object.points)} fill="none" stroke="transparent" strokeWidth={hitStroke} />;
        default: {
          const bounds = getObjectBounds(object, project.variables);
          return <rect x={bounds.x - 5} y={bounds.y - 5} width={Math.max(10, bounds.width + 10)} height={Math.max(10, bounds.height + 10)} fill="transparent" stroke="none" />;
        }
      }
    })();

    return <g key={object.id} data-object-id={object.id} className={object.locked ? 'object-locked' : ''}>{content}{hit}</g>;
  }

  function selectionOverlay() {
    if (!selectedObject) return null;
    const bounds = getObjectBounds(selectedObject, project.variables);
    const pad = 8 / view.zoom;
    return (
      <g data-ui-only="true" pointerEvents="none">
        <rect
          x={bounds.x - pad}
          y={bounds.y - pad}
          width={Math.max(1, bounds.width + pad * 2)}
          height={Math.max(1, bounds.height + pad * 2)}
          fill="none"
          stroke="#6455ea"
          strokeWidth={1.6}
          strokeDasharray="7 5"
          className="selection-outline"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    );
  }

  const viewBox = `${view.x} ${view.y} ${project.canvas.width / view.zoom} ${project.canvas.height / view.zoom}`;

  function saveProject() {
    const safeTitle = project.title.trim().replace(/[\\/:*?"<>|]/g, '_') || 'graphanta-project';
    downloadJson(`${safeTitle}.graphanta.json`, project);
    setStatus('プロジェクトファイルを保存しました');
  }

  async function loadProjectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = await readJsonFile<unknown>(file);
      if (!isProject(data)) throw new Error('Graphantaのプロジェクト形式ではありません');
      commitHistory(project);
      setProject(data);
      setSelectedId(null);
      setView({ x: 0, y: 0, zoom: 1 });
      setStatus('プロジェクトを読み込みました');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'プロジェクトを読み込めませんでした');
    }
  }

  async function loadSettingsFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = await readJsonFile<unknown>(file);
      if (!isSettings(data)) throw new Error('Graphantaの環境設定形式ではありません');
      setSettings(data);
      setStatus('環境設定を読み込みました');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '環境設定を読み込めませんでした');
    }
  }

  function newProject() {
    if (project.objects.length > 0 && !window.confirm('現在の作業を閉じて新規作成しますか？')) return;
    commitHistory(project);
    setProject(createInitialProject());
    setSelectedId(null);
    setView({ x: 0, y: 0, zoom: 1 });
    setStatus('新しいプロジェクトを作成しました');
  }

  async function screenshot() {
    if (!svgRef.current) return;
    try {
      setStatus('スクリーンショットを生成しています');
      await openSvgAsPng(svgRef.current, project.canvas.background);
      setStatus('スクリーンショットを新しいウィンドウに表示しました');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'スクリーンショットを生成できませんでした');
      setStatus('スクリーンショットの生成に失敗しました');
    }
  }

  async function togglePresentation() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
    setPresentation(true);
  }

  function addVariable() {
    const used = new Set(project.variables.map((variable) => variable.name));
    const candidates = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const name = candidates.find((candidate) => !used.has(candidate)) ?? `v${project.variables.length + 1}`;
    const variable: VariableDef = { id: createId('var'), name, value: 1, min: 0, max: 10, step: 1 };
    mutateProject((current) => ({ ...current, variables: [...current.variables, variable] }));
  }

  function updateVariable(id: string, patch: Partial<VariableDef>, addHistory = true) {
    mutateProject((current) => ({
      ...current,
      variables: current.variables.map((variable) => (variable.id === id ? { ...variable, ...patch } : variable)),
    }), addHistory);
  }

  function addExpression() {
    const expression: ExpressionDef = {
      id: createId('expr'), label: `式${project.expressions.length + 1}`, source: '', visible: true,
    };
    mutateProject((current) => ({ ...current, expressions: [...current.expressions, expression] }));
  }

  function updateExpression(id: string, patch: Partial<ExpressionDef>, addHistory = true) {
    mutateProject((current) => ({
      ...current,
      expressions: current.expressions.map((expression) => (expression.id === id ? { ...expression, ...patch } : expression)),
    }), addHistory);
  }

  function placeExpression(expression: ExpressionDef) {
    setModal({
      kind: 'math',
      point: {
        x: view.x + project.canvas.width / view.zoom / 2,
        y: view.y + project.canvas.height / view.zoom / 2,
      },
      value: expression.source,
    });
  }

  return (
    <div className={`app-shell ${presentation ? 'presentation-mode' : ''}`}>
      <header className="menu-bar">
        <button type="button" className="app-mark" aria-label="Graphantaについて" onClick={() => setModal({ kind: 'about' })}>
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <path d="M8 31V9M8 31H33" />
            <path d="M11 27C15 24 17 14 22 18C26 21 27 10 32 9" />
            <circle cx="22" cy="18" r="2.2" />
          </svg>
        </button>

        <nav className="menu-actions" aria-label="メニュー">
          <button type="button" onClick={newProject}><span>新規</span></button>
          <button type="button" onClick={() => projectInputRef.current?.click()}><Icon name="open" size={19} /><span>読込</span></button>
          <button type="button" onClick={saveProject}><Icon name="save" size={19} /><span>保存</span></button>
          <span className="menu-divider" />
          <button type="button" aria-label="元に戻す" title="元に戻す" onClick={undo} disabled={undoStack.current.length === 0} data-history={historyRevision}><Icon name="undo" size={19} /></button>
          <button type="button" aria-label="やり直す" title="やり直す" onClick={redo} disabled={redoStack.current.length === 0} data-history={historyRevision}><Icon name="redo" size={19} /></button>
          <span className="menu-divider" />
          <button type="button" onClick={screenshot}><Icon name="camera" size={19} /><span>スクショ</span></button>
          <button type="button" onClick={togglePresentation}><Icon name="fullscreen" size={19} /><span>発表</span></button>
          <button type="button" aria-label="設定" title="設定" onClick={() => setModal({ kind: 'settings' })}><Icon name="settings" size={19} /></button>
        </nav>

        <div className="view-control" aria-label="表示倍率">
          <button type="button" onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>全体表示</button>
          <output>{Math.round(view.zoom * 100)}%</output>
        </div>

        <input
          className="project-title"
          value={project.title}
          aria-label="プロジェクト名"
          title="プロジェクト名"
          onChange={(event) => setProject((current) => ({ ...current, title: event.target.value }))}
        />

        <button type="button" className="wordmark" onClick={() => setModal({ kind: 'about' })}>
          <strong>Graphanta</strong>
          <span>visual mathematics</span>
        </button>
      </header>

      <main className={`workspace toolbar-${settings.toolbarSide} ${panelCollapsed.tweak && panelCollapsed.expressions ? 'panels-collapsed' : ''}`}>
        {settings.toolbarSide === 'left' && <Toolbar tools={visibleTools} activeTool={activeTool} onChange={(tool) => { setActiveTool(tool); setPolygonPoints([]); }} />}

        <section className="plot-shell">
          <div className="plot-viewport">
            <svg
              ref={svgRef}
              className={`plot-canvas cursor-${activeTool}`}
              viewBox={viewBox}
              role="application"
              aria-label="Graphanta プロットエリア"
              onPointerDown={beginPointer}
              onPointerMove={movePointer}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onWheel={onWheel}
              onDoubleClick={() => {
                if (activeTool === 'polygon') {
                  setPolygonPoints((points) => {
                    const cleaned = points.length >= 2 ? points.slice(0, -1) : points;
                    if (cleaned.length >= 3) {
                      const object: GraphicObject = { id: createId('polygon'), type: 'polygon', points: cleaned, ...defaultStyle() };
                      mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
                      setSelectedId(object.id);
                      setStatus('多角形を作成しました');
                      return [];
                    }
                    return points;
                  });
                }
              }}
            >
              <defs>
                <pattern id="small-grid" width={project.canvas.gridSize} height={project.canvas.gridSize} patternUnits="userSpaceOnUse">
                  <path d={`M ${project.canvas.gridSize} 0 L 0 0 0 ${project.canvas.gridSize}`} fill="none" stroke="#dfe4f0" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
                </pattern>
                <pattern id="grid" width={project.canvas.gridSize * 5} height={project.canvas.gridSize * 5} patternUnits="userSpaceOnUse">
                  <rect width={project.canvas.gridSize * 5} height={project.canvas.gridSize * 5} fill="url(#small-grid)" />
                  <path d={`M ${project.canvas.gridSize * 5} 0 L 0 0 0 ${project.canvas.gridSize * 5}`} fill="none" stroke="#c6cede" strokeWidth={1.1} vectorEffect="non-scaling-stroke" />
                </pattern>
                <marker id="arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L10,4 L0,8 z" fill={settings.defaultStroke} />
                </marker>
              </defs>
              <rect x={view.x} y={view.y} width={project.canvas.width / view.zoom} height={project.canvas.height / view.zoom} fill={project.canvas.background} />
              {project.canvas.gridVisible && <rect x={view.x} y={view.y} width={project.canvas.width / view.zoom} height={project.canvas.height / view.zoom} fill="url(#grid)" />}
              {project.objects.map(renderObject)}
              {polygonPoints.length > 0 && (
                <g data-ui-only="true" pointerEvents="none">
                  <polyline points={polygonPoints.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#6d5dfc" strokeWidth={2} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />
                  {polygonPoints.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={5 / view.zoom} fill="#6d5dfc" />)}
                </g>
              )}
              {selectionOverlay()}
            </svg>
          </div>
          <footer className="status-bar">
            <span><strong>{TOOL_LABELS[activeTool]}</strong>　{status}</span>
            <span>{project.objects.length}要素・オフライン保存</span>
          </footer>
        </section>

        {settings.toolbarSide === 'right' && <Toolbar tools={visibleTools} activeTool={activeTool} onChange={(tool) => { setActiveTool(tool); setPolygonPoints([]); }} />}

        <aside className="side-panels">
          <section className={`side-panel tweak-panel ${panelCollapsed.tweak ? 'collapsed' : ''}`}>
            <button type="button" className="panel-heading" aria-expanded={!panelCollapsed.tweak} title={panelCollapsed.tweak ? 'ツウィークを開く' : 'ツウィークを畳む'} onClick={() => setPanelCollapsed((current) => ({ ...current, tweak: !current.tweak }))}>
              <span className="panel-title">ツウィーク</span><span className="panel-short">T</span><Icon name="chevron" size={18} />
            </button>
            {!panelCollapsed.tweak && (
              <div className="panel-content tweak-content">
                <TweakPanel
                  project={project}
                  selected={selectedObject}
                  onCanvasChange={(patch) => mutateProject((current) => ({ ...current, canvas: { ...current.canvas, ...patch } }))}
                  onObjectChange={(updater) => selectedObject && updateObject(selectedObject.id, updater)}
                  onDelete={deleteSelected}
                  onDuplicate={duplicateSelected}
                  onFinalizePolygon={finalizePolygon}
                  polygonCount={polygonPoints.length}
                />
              </div>
            )}
          </section>

          <section className={`side-panel expression-panel ${panelCollapsed.expressions ? 'collapsed' : ''}`}>
            <button type="button" className="panel-heading" aria-expanded={!panelCollapsed.expressions} title={panelCollapsed.expressions ? '数式・変数を開く' : '数式・変数を畳む'} onClick={() => setPanelCollapsed((current) => ({ ...current, expressions: !current.expressions }))}>
              <span className="panel-title">f 数式・変数</span><span className="panel-short">f</span><Icon name="chevron" size={18} />
            </button>
            {!panelCollapsed.expressions && (
              <div className="panel-content">
                <ExpressionPanel
                  project={project}
                  onAddVariable={addVariable}
                  onUpdateVariable={updateVariable}
                  onDeleteVariable={(id) => mutateProject((current) => ({ ...current, variables: current.variables.filter((variable) => variable.id !== id) }))}
                  onAddExpression={addExpression}
                  onUpdateExpression={updateExpression}
                  onDeleteExpression={(id) => mutateProject((current) => ({ ...current, expressions: current.expressions.filter((expression) => expression.id !== id) }))}
                  onEditDetailed={(expression) => setModal({ kind: 'math', point: { x: 0, y: 0 }, value: expression.source, expressionId: expression.id })}
                  onPlace={placeExpression}
                  onStartSliderHistory={() => commitHistory(project)}
                />
              </div>
            )}
          </section>
        </aside>
      </main>

      {presentation && <button className="exit-presentation" type="button" onClick={togglePresentation}>発表モードを終了</button>}

      <input ref={projectInputRef} type="file" accept=".json,.graphanta.json,application/json" hidden onChange={loadProjectFile} />
      <input ref={settingsInputRef} type="file" accept=".json,.graphanta-settings.json,application/json" hidden onChange={loadSettingsFile} />

      {modal?.kind === 'settings' && (
        <Modal title="環境設定" wide onClose={() => setModal(null)}>
          <SettingsEditor
            settings={settings}
            onChange={setSettings}
            onSave={() => downloadJson('graphanta-settings.json', settings)}
            onLoad={() => settingsInputRef.current?.click()}
            onReset={() => setSettings(createDefaultSettings())}
          />
        </Modal>
      )}

      {modal?.kind === 'text' && (
        <Modal title="文字を追加" onClose={() => setModal(null)}>
          <TextEntry
            initial={modal.value}
            onSubmit={(value) => { addText(value, modal.point); setModal(null); }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.kind === 'math' && (
        <Modal title="数式ウィンドウ" wide onClose={() => setModal(null)}>
          <MathEditor
            initial={modal.value}
            onSubmit={(value) => {
              if (modal.expressionId) updateExpression(modal.expressionId, { source: value });
              else addMath(value, modal.point);
              setModal(null);
            }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.kind === 'about' && (
        <Modal title="Graphanta" onClose={() => setModal(null)}>
          <div className="about-box">
            <div className="about-logo">G</div>
            <p><strong>Graphanta {APP_VERSION}</strong></p>
            <p>数学的な思考と表現を、速く・簡単に・見やすく支えるローカルファーストの作図環境です。</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface TweakPanelProps {
  project: GraphantaProject;
  selected: GraphicObject | null;
  onCanvasChange: (patch: Partial<GraphantaProject['canvas']>) => void;
  onObjectChange: (updater: (object: GraphicObject) => GraphicObject) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onFinalizePolygon: () => void;
  polygonCount: number;
}

function TweakPanel({ project, selected, onCanvasChange, onObjectChange, onDelete, onDuplicate, onFinalizePolygon, polygonCount }: TweakPanelProps) {
  const patch = (changes: Partial<GraphicObject>) => onObjectChange((object) => ({ ...object, ...changes } as GraphicObject));
  if (!selected) {
    return (
      <>
        <p className="panel-hint">要素を選択すると、形・色・数値を調整できます。</p>
        {polygonCount > 0 && (
          <button type="button" className="primary-button full" onClick={onFinalizePolygon} disabled={polygonCount < 3}>多角形を確定（{polygonCount}点）</button>
        )}
        <Field label="背景色"><input type="color" value={project.canvas.background} onChange={(event) => onCanvasChange({ background: event.target.value })} /></Field>
        <Toggle label="方眼を表示" checked={project.canvas.gridVisible} onChange={(checked) => onCanvasChange({ gridVisible: checked })} />
        <Field label="方眼間隔"><input type="number" min="5" max="100" value={project.canvas.gridSize} onChange={(event) => onCanvasChange({ gridSize: clamp(Number(event.target.value), 5, 100) })} /></Field>
        <Toggle label="方眼に吸着" checked={project.canvas.snapGrid} onChange={(checked) => onCanvasChange({ snapGrid: checked })} />
        <Toggle label="点・交点に吸着（準備中）" checked={project.canvas.snapPoints} onChange={(checked) => onCanvasChange({ snapPoints: checked })} disabled />
      </>
    );
  }

  return (
    <>
      <div className="selected-type"><span>{TOOL_LABELS[selected.type === 'line' ? 'line' : selected.type === 'segment' ? 'segment' : selected.type]}</span><code>{selected.id.slice(0, 8)}</code></div>
      <div className="inline-actions">
        <button type="button" onClick={onDuplicate}><Icon name="duplicate" size={18} />複製</button>
        <button type="button" className="danger" onClick={onDelete}><Icon name="delete" size={18} />削除</button>
      </div>
      <Field label="線の色"><input type="color" value={selected.stroke} onChange={(event) => patch({ stroke: event.target.value })} /></Field>
      <Field label="塗りの色">
        <div className="fill-control">
          <input type="color" value={selected.fill === 'transparent' ? '#ffffff' : selected.fill} disabled={selected.fill === 'transparent'} onChange={(event) => patch({ fill: event.target.value })} />
          <Toggle label="透明" checked={selected.fill === 'transparent'} onChange={(checked) => patch({ fill: checked ? 'transparent' : '#dfe5ff' })} compact />
        </div>
      </Field>
      <Field label="線の太さ"><input type="range" min="0.5" max="12" step="0.5" value={selected.strokeWidth} onChange={(event) => patch({ strokeWidth: Number(event.target.value) })} /><output>{selected.strokeWidth}</output></Field>
      <Field label="不透明度"><input type="range" min="0.1" max="1" step="0.05" value={selected.opacity} onChange={(event) => patch({ opacity: Number(event.target.value) })} /><output>{Math.round(selected.opacity * 100)}%</output></Field>
      <Toggle label="固定する" checked={Boolean(selected.locked)} onChange={(checked) => patch({ locked: checked })} />

      {selected.type === 'rectangle' && <Field label="角の丸み"><input type="number" min="0" max="100" value={selected.radius} onChange={(event) => patch({ radius: Number(event.target.value) })} /></Field>}
      {selected.type === 'text' && (
        <>
          <Field label="文字"><textarea value={selected.text} onChange={(event) => patch({ text: event.target.value })} /></Field>
          <Field label="文字サイズ"><input type="number" min="8" max="160" value={selected.fontSize} onChange={(event) => patch({ fontSize: Number(event.target.value) })} /></Field>
        </>
      )}
      {selected.type === 'math' && (
        <>
          <Field label="数式"><textarea value={selected.expression} onChange={(event) => patch({ expression: event.target.value })} /></Field>
          <Field label="文字サイズ"><input type="number" min="8" max="160" value={selected.fontSize} onChange={(event) => patch({ fontSize: Number(event.target.value) })} /></Field>
        </>
      )}
      {selected.type === 'array' && (
        <>
          <p className="binding-note">数値の代わりに <code>=a</code> や <code>=a+1</code> と入力すると変数に連動します。</p>
          <Field label="行数"><input value={selected.rowsExpr} onChange={(event) => patch({ rowsExpr: event.target.value })} /></Field>
          <Field label="列数"><input value={selected.colsExpr} onChange={(event) => patch({ colsExpr: event.target.value })} /></Field>
          <Field label="シンボル">
            <select value={selected.symbol} onChange={(event) => patch({ symbol: event.target.value as ArrayObject['symbol'] })}>
              <option value="circle">円</option><option value="square">四角</option><option value="dot">点</option><option value="cross">×</option>
            </select>
          </Field>
          <Field label="大きさ"><input type="range" min="2" max="28" step="1" value={selected.symbolSize} onChange={(event) => patch({ symbolSize: Number(event.target.value) })} /><output>{selected.symbolSize}</output></Field>
        </>
      )}
      {selected.type === 'segment' && (
        <>
          <p className="binding-note">目盛数・始値・終値は変数式にできます。</p>
          <Field label="目盛区間数"><input value={selected.ticksExpr} onChange={(event) => patch({ ticksExpr: event.target.value })} /></Field>
          <Field label="始めの値"><input value={selected.startValueExpr} onChange={(event) => patch({ startValueExpr: event.target.value })} /></Field>
          <Field label="終わりの値"><input value={selected.endValueExpr} onChange={(event) => patch({ endValueExpr: event.target.value })} /></Field>
          <Toggle label="数値を表示" checked={selected.showValues} onChange={(checked) => patch({ showValues: checked })} />
        </>
      )}
    </>
  );
}

interface ExpressionPanelProps {
  project: GraphantaProject;
  onAddVariable: () => void;
  onUpdateVariable: (id: string, patch: Partial<VariableDef>, addHistory?: boolean) => void;
  onDeleteVariable: (id: string) => void;
  onAddExpression: () => void;
  onUpdateExpression: (id: string, patch: Partial<ExpressionDef>, addHistory?: boolean) => void;
  onDeleteExpression: (id: string) => void;
  onEditDetailed: (expression: ExpressionDef) => void;
  onPlace: (expression: ExpressionDef) => void;
  onStartSliderHistory: () => void;
}

function ExpressionPanel({ project, onAddVariable, onUpdateVariable, onDeleteVariable, onAddExpression, onUpdateExpression, onDeleteExpression, onEditDetailed, onPlace, onStartSliderHistory }: ExpressionPanelProps) {
  return (
    <>
      <div className="subheading"><span>変数フェーダー</span><button type="button" onClick={onAddVariable}>＋追加</button></div>
      <div className="variable-list">
        {project.variables.map((variable) => (
          <article className="variable-card" key={variable.id}>
            <div className="variable-head">
              <input className="variable-name" aria-label="変数名" value={variable.name} onChange={(event) => onUpdateVariable(variable.id, { name: event.target.value.replace(/[^A-Za-z_]/g, '').slice(0, 8) })} />
              <output>{variable.value}</output>
              <button type="button" className="mini-delete" onClick={() => onDeleteVariable(variable.id)}>×</button>
            </div>
            <input type="range" min={variable.min} max={variable.max} step={variable.step} value={variable.value} onPointerDown={onStartSliderHistory} onChange={(event) => onUpdateVariable(variable.id, { value: Number(event.target.value) }, false)} />
            <div className="variable-range">
              <label>最小<input type="number" value={variable.min} onChange={(event) => onUpdateVariable(variable.id, { min: Number(event.target.value) })} /></label>
              <label>刻み<input type="number" min="0.001" value={variable.step} onChange={(event) => onUpdateVariable(variable.id, { step: Math.max(0.001, Number(event.target.value)) })} /></label>
              <label>最大<input type="number" value={variable.max} onChange={(event) => onUpdateVariable(variable.id, { max: Number(event.target.value) })} /></label>
            </div>
          </article>
        ))}
      </div>

      <div className="subheading"><span>数式</span><button type="button" onClick={onAddExpression}>＋追加</button></div>
      <div className="expression-list">
        {project.expressions.map((expression) => (
          <article className="expression-card" key={expression.id}>
            <div className="expression-head">
              <input type="checkbox" checked={expression.visible} onChange={(event) => onUpdateExpression(expression.id, { visible: event.target.checked })} aria-label="表示" />
              <input className="expression-label" value={expression.label} onChange={(event) => onUpdateExpression(expression.id, { label: event.target.value })} />
              <button type="button" className="mini-delete" onClick={() => onDeleteExpression(expression.id)}>×</button>
            </div>
            <input className="expression-source" placeholder="例: y=a*x^2" value={expression.source} onChange={(event) => onUpdateExpression(expression.id, { source: event.target.value }, false)} onBlur={(event) => onUpdateExpression(expression.id, { source: event.target.value })} />
            <div className="expression-preview">{prettyMath(expression.source) || '数式を入力'}</div>
            <div className="expression-actions">
              <button type="button" onClick={() => onEditDetailed(expression)}>詳細入力</button>
              <button type="button" onClick={() => onPlace(expression)} disabled={!expression.source.trim()}>配置</button>
            </div>
          </article>
        ))}
      </div>
      <div className="function-placeholder"><Icon name="function" size={20} /><span>関数グラフ描画はv3で有効になります。</span></div>
    </>
  );
}

interface SettingsEditorProps {
  settings: GraphantaSettings;
  onChange: (settings: GraphantaSettings) => void;
  onSave: () => void;
  onLoad: () => void;
  onReset: () => void;
}

function SettingsEditor({ settings, onChange, onSave, onLoad, onReset }: SettingsEditorProps) {
  const toggleTool = (tool: ToolId, checked: boolean) => {
    const visibleTools = checked
      ? [...new Set([...settings.visibleTools, tool])]
      : settings.visibleTools.filter((item) => item !== tool);
    onChange({ ...settings, visibleTools });
  };
  return (
    <div className="settings-grid">
      <section>
        <h3>レイアウト</h3>
        <Field label="ツールバー位置">
          <select value={settings.toolbarSide} onChange={(event) => onChange({ ...settings, toolbarSide: event.target.value as 'left' | 'right' })}>
            <option value="right">右側</option><option value="left">左側</option>
          </select>
        </Field>
        <Toggle label="前回の作業を自動復旧" checked={settings.autoRestore} onChange={(checked) => onChange({ ...settings, autoRestore: checked })} />
        <h3>新規要素の初期値</h3>
        <Field label="線の色"><input type="color" value={settings.defaultStroke} onChange={(event) => onChange({ ...settings, defaultStroke: event.target.value })} /></Field>
        <Field label="線の太さ"><input type="number" min="0.5" max="12" step="0.5" value={settings.defaultStrokeWidth} onChange={(event) => onChange({ ...settings, defaultStrokeWidth: Number(event.target.value) })} /></Field>
      </section>
      <section>
        <h3>表示するツール</h3>
        <div className="tool-settings-list">
          {ALL_TOOLS.map((tool) => (
            <label key={tool} className="tool-setting">
              <input type="checkbox" checked={settings.visibleTools.includes(tool)} onChange={(event) => toggleTool(tool, event.target.checked)} />
              <Icon name={tool} size={20} /><span>{TOOL_LABELS[tool]}</span>
            </label>
          ))}
        </div>
      </section>
      <footer className="settings-footer">
        <button type="button" onClick={onSave}>環境設定を書き出す</button>
        <button type="button" onClick={onLoad}>環境設定を読み込む</button>
        <button type="button" className="danger" onClick={onReset}>初期設定に戻す</button>
      </footer>
    </div>
  );
}

function TextEntry({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(value); }}>
      <textarea className="large-entry" autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="表示する文字を入力" />
      <div className="modal-actions"><button type="button" onClick={onCancel}>キャンセル</button><button type="submit" className="primary-button" disabled={!value.trim()}>追加</button></div>
    </form>
  );
}

function MathEditor({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const insert = (token: string, caretOffset = token.length) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setValue((current) => current + token);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = value.slice(0, start) + token + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + caretOffset, start + caretOffset);
    });
  };
  const palette = [
    { label: '分数', token: '()/()', offset: 1 },
    { label: '平方根', token: 'sqrt()', offset: 5 },
    { label: '累乗', token: '^()', offset: 2 },
    { label: '下付き', token: '_()', offset: 2 },
    { label: 'π', token: 'pi', offset: 2 },
    { label: '絶対値', token: 'abs()', offset: 4 },
    { label: 'Σ', token: 'sum()', offset: 4 },
    { label: '∫', token: 'int()', offset: 4 },
    { label: '行列', token: 'matrix([,],[,])', offset: 8 },
  ];
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(value); }} className="math-editor">
      <div className="math-palette">
        {palette.map((item) => <button type="button" key={item.label} onClick={() => insert(item.token, item.offset)}>{item.label}</button>)}
      </div>
      <div className="math-workspace">
        <textarea ref={textareaRef} autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="例: y=a*x^2 / sqrt(2)" />
        <div className="math-live-preview"><span>プレビュー</span><strong>{prettyMath(value) || '—'}</strong></div>
      </div>
      <p className="math-help">v1αでは構造入力用の記号パレットと軽量プレビューを実装しています。複分数などの視覚的なボックス編集は次の開発段階で強化します。</p>
      <div className="modal-actions"><button type="button" onClick={onCancel}>キャンセル</button><button type="submit" className="primary-button" disabled={!value.trim()}>確定</button></div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span><div>{children}</div></label>;
}

function Toggle({ label, checked, onChange, disabled = false, compact = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <label className={`toggle ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track"><span /></span><em>{label}</em>
    </label>
  );
}

export default App;
