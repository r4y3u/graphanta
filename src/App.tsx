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
import { createId, normalizeRect, pointsToPath, translateObject } from './lib/geometry';
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
  BaseObject,
  EllipseObject,
  ExpressionDef,
  GraphicObject,
  GraphantaProject,
  GraphantaSettings,
  LineObject,
  MathObject,
  MeasureMode,
  PenObject,
  Point,
  RectangleObject,
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

interface StylePreset {
  stroke: string;
  fill: string;
  strokeWidth: number;
  opacity: number;
}

interface ToolPresets {
  pen: StylePreset;
  line: StylePreset & { start: Point; end: Point };
  arrow: StylePreset & { start: Point; end: Point; arrowSize: number };
  rectangle: StylePreset & { radius: number };
  ellipse: StylePreset & { center: Point; rx: number; ry: number };
  polygon: StylePreset;
  text: StylePreset & { fontSize: number };
  math: StylePreset & { fontSize: number };
  array: StylePreset & { rowsExpr: string; colsExpr: string; symbol: ArrayObject['symbol']; symbolSize: number };
  segment: StylePreset & {
    mode: MeasureMode;
    tickIntervalExpr: string;
    labelIntervalExpr: string;
    maxValueExpr: string;
    divisionPercents: number[];
  };
}

type Interaction =
  | { kind: 'draw'; objectId: string; start: Point }
  | { kind: 'move'; objectId: string; start: Point; original: GraphicObject }
  | { kind: 'pan'; clientStart: Point; originalView: ViewState }
  | { kind: 'zoom'; start: Point }
  | null;

type ModalState =
  | { kind: 'settings' }
  | { kind: 'text'; point: Point; value: string }
  | { kind: 'math'; point: Point; value: string; expressionId?: string }
  | { kind: 'about' }
  | null;

const MIN_DRAW_SIZE = 4;
const TWO_PI = Math.PI * 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundValue(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function toHalfWidth(value: string): string {
  return value
    .replace(/[！-～]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

function sanitizeExpression(value: string): string {
  return toHalfWidth(value).replace(/[^A-Za-z0-9_+\-*/^().,= ]/g, '');
}

function sanitizeNumberText(value: string): string {
  return toHalfWidth(value).replace(/[^0-9+\-.]/g, '');
}

function angleOf(start: Point, end: Point): number {
  return Math.atan2(end.y - start.y, end.x - start.x);
}

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= TWO_PI;
  while (angle < -Math.PI) angle += TWO_PI;
  return angle;
}

function rotatePoint(point: Point, center: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

function createPresets(settings: GraphantaSettings): ToolPresets {
  const lineStyle = { stroke: settings.defaultStroke, fill: 'transparent', strokeWidth: settings.defaultStrokeWidth, opacity: 1 };
  const shapeStyle = { stroke: settings.defaultStroke, fill: settings.defaultFill, strokeWidth: settings.defaultStrokeWidth, opacity: 1 };
  return {
    pen: { ...lineStyle },
    line: { ...lineStyle, start: { x: -4, y: 0 }, end: { x: 4, y: 0 } },
    arrow: { ...lineStyle, start: { x: -4, y: 0 }, end: { x: 4, y: 0 }, arrowSize: 14 },
    rectangle: { ...shapeStyle, radius: 0 },
    ellipse: { ...shapeStyle, center: { x: 0, y: 0 }, rx: 2, ry: 2 },
    polygon: { ...shapeStyle },
    text: { ...lineStyle, fontSize: 28 },
    math: { ...lineStyle, fontSize: 30 },
    array: { ...lineStyle, rowsExpr: '3', colsExpr: '4', symbol: 'circle', symbolSize: 9 },
    segment: {
      ...lineStyle,
      mode: 'numberLine',
      tickIntervalExpr: '1',
      labelIntervalExpr: '1',
      maxValueExpr: '10',
      divisionPercents: [50],
    },
  };
}

function normalizeSettings(value: GraphantaSettings | null): GraphantaSettings {
  const base = createDefaultSettings();
  if (!value) return base;
  const visibleTools = [...new Set(value.visibleTools.filter((tool) => ALL_TOOLS.includes(tool)))];
  if (visibleTools.includes('pan') && !visibleTools.includes('zoom')) visibleTools.splice(visibleTools.indexOf('pan') + 1, 0, 'zoom');
  return { ...base, ...value, visibleTools };
}

function normalizeObject(object: GraphicObject): GraphicObject {
  if (object.type === 'arrow') return { ...object, arrowSize: object.arrowSize ?? 14 };
  if (object.type === 'rectangle' || object.type === 'ellipse' || object.type === 'array' || object.type === 'pen' || object.type === 'polygon') {
    return { ...object, rotation: object.rotation ?? 0 };
  }
  if (object.type === 'segment') {
    const oldEnd = object.endValueExpr ?? '10';
    return {
      ...object,
      mode: object.mode ?? 'numberLine',
      tickIntervalExpr: object.tickIntervalExpr ?? '1',
      labelIntervalExpr: object.labelIntervalExpr ?? (object.showValues === false ? '0' : '1'),
      maxValueExpr: object.maxValueExpr ?? oldEnd,
      divisionPercents: Array.isArray(object.divisionPercents) && object.divisionPercents.length ? object.divisionPercents : [50],
      rotation: object.rotation ?? 0,
    };
  }
  return object;
}

function normalizeProject(value: GraphantaProject): GraphantaProject {
  const base = createInitialProject();
  return {
    ...base,
    ...value,
    appVersion: APP_VERSION,
    canvas: { ...base.canvas, ...value.canvas },
    objects: value.objects.map(normalizeObject),
    expressions: Array.isArray(value.expressions) ? value.expressions : base.expressions,
    variables: Array.isArray(value.variables) ? value.variables : base.variables,
  };
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

function getObjectBounds(object: GraphicObject): { x: number; y: number; width: number; height: number } {
  switch (object.type) {
    case 'pen':
    case 'polygon': {
      const xs = object.points.map((point) => point.x);
      const ys = object.points.map((point) => point.y);
      if (!xs.length) return { x: 0, y: 0, width: 0, height: 0 };
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
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

function toolForObject(object: GraphicObject): ToolId {
  if (object.type === 'line') return 'line';
  if (object.type === 'arrow') return 'arrow';
  if (object.type === 'segment') return 'segment';
  return object.type;
}

function App() {
  const initialSettings = useMemo(() => normalizeSettings(loadSettingsLocal()), []);
  const [project, setProject] = useState<GraphantaProject>(() => createInitialProject());
  const [settings, setSettings] = useState<GraphantaSettings>(initialSettings);
  const [presets, setPresets] = useState<ToolPresets>(() => createPresets(initialSettings));
  const [activeTool, setActiveTool] = useState<ToolId>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, zoom: 1 });
  const [interaction, setInteraction] = useState<Interaction>(null);
  const [zoomBox, setZoomBox] = useState<{ start: Point; end: Point } | null>(null);
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

  const selectedObject = useMemo(() => project.objects.find((object) => object.id === selectedId) ?? null, [project.objects, selectedId]);
  const visibleTools = useMemo(() => settings.visibleTools.filter((tool) => ALL_TOOLS.includes(tool)), [settings.visibleTools]);
  const coordinateUnitPx = Math.min(project.canvas.width, project.canvas.height) / (2 * Math.max(1, project.canvas.coordinatePrecision));
  const coordinateOrigin = useMemo<Point>(() => ({ x: project.canvas.width / 2, y: project.canvas.height / 2 }), [project.canvas.width, project.canvas.height]);

  const worldToCoordinate = useCallback((point: Point): Point => ({
    x: roundValue((point.x - coordinateOrigin.x) / coordinateUnitPx),
    y: roundValue((coordinateOrigin.y - point.y) / coordinateUnitPx),
  }), [coordinateOrigin, coordinateUnitPx]);

  const coordinateToWorld = useCallback((point: Point): Point => ({
    x: coordinateOrigin.x + point.x * coordinateUnitPx,
    y: coordinateOrigin.y - point.y * coordinateUnitPx,
  }), [coordinateOrigin, coordinateUnitPx]);

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
    mutateProject((current) => ({ ...current, objects: current.objects.map((object) => object.id === id ? updater(object) : object) }), addHistory);
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

  useEffect(() => saveSettingsLocal(settings), [settings]);

  useEffect(() => {
    if (restored || !settings.autoRestore) return;
    setRestored(true);
    loadAutosave().then((saved) => {
      if (!saved || saved.objects.length === 0) return;
      if (window.confirm('前回の作業を復元しますか？')) {
        setProject(normalizeProject(saved));
        setStatus('前回の作業を復元しました');
      }
    }).catch(() => setStatus('自動復旧データを確認できませんでした'));
  }, [restored, settings.autoRestore]);

  useEffect(() => {
    const timer = window.setTimeout(() => saveAutosave(project).catch(() => undefined), 700);
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
        setZoomBox(null);
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

  const rawWorldPoint = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const inverse = svg.getScreenCTM()?.inverse();
    const transformed = inverse ? point.matrixTransform(inverse) : point;
    return { x: transformed.x, y: transformed.y };
  }, []);

  const snapWorldPoint = useCallback((point: Point): Point => {
    if (!project.canvas.snapGrid || (!project.canvas.gridVisible && !project.canvas.axesVisible)) return point;
    const step = project.canvas.axesVisible
      ? coordinateUnitPx * Math.max(project.canvas.tickInterval || 1, 0.0001)
      : project.canvas.gridSize;
    return {
      x: coordinateOrigin.x + Math.round((point.x - coordinateOrigin.x) / step) * step,
      y: coordinateOrigin.y + Math.round((point.y - coordinateOrigin.y) / step) * step,
    };
  }, [coordinateOrigin, coordinateUnitPx, project.canvas.axesVisible, project.canvas.gridSize, project.canvas.gridVisible, project.canvas.snapGrid, project.canvas.tickInterval]);

  const worldPoint = useCallback((clientX: number, clientY: number): Point => snapWorldPoint(rawWorldPoint(clientX, clientY)), [rawWorldPoint, snapWorldPoint]);

  function styleFor(tool: ToolId): StylePreset {
    const source = tool === 'pen' ? presets.pen
      : tool === 'line' ? presets.line
      : tool === 'arrow' ? presets.arrow
      : tool === 'rectangle' ? presets.rectangle
      : tool === 'ellipse' ? presets.ellipse
      : tool === 'polygon' ? presets.polygon
      : tool === 'text' ? presets.text
      : tool === 'math' ? presets.math
      : tool === 'array' ? presets.array
      : tool === 'segment' ? presets.segment
      : { stroke: settings.defaultStroke, fill: settings.defaultFill, strokeWidth: settings.defaultStrokeWidth, opacity: 1 };
    return { stroke: source.stroke, fill: source.fill, strokeWidth: source.strokeWidth, opacity: source.opacity };
  }

  const createDrawObject = useCallback((tool: ToolId, point: Point): GraphicObject | null => {
    const style = styleFor(tool);
    switch (tool) {
      case 'pen':
        return { id: createId('pen'), type: 'pen', points: [point], rotation: 0, ...style };
      case 'line':
        return { id: createId('line'), type: 'line', start: point, end: point, ...style };
      case 'arrow':
        return { id: createId('arrow'), type: 'arrow', start: point, end: point, arrowSize: presets.arrow.arrowSize, ...style };
      case 'rectangle':
        return { id: createId('rectangle'), type: 'rectangle', x: point.x, y: point.y, width: 0, height: 0, radius: presets.rectangle.radius, rotation: 0, ...style };
      case 'ellipse':
        return { id: createId('ellipse'), type: 'ellipse', cx: point.x, cy: point.y, rx: 0, ry: 0, rotation: 0, ...style };
      case 'array':
        return {
          id: createId('array'), type: 'array', x: point.x, y: point.y, width: 0, height: 0,
          rowsExpr: presets.array.rowsExpr, colsExpr: presets.array.colsExpr, symbol: presets.array.symbol,
          symbolSize: presets.array.symbolSize, rotation: 0, ...style,
        };
      case 'segment':
        return {
          id: createId('segment'), type: 'segment', start: point, end: point,
          mode: presets.segment.mode, tickIntervalExpr: presets.segment.tickIntervalExpr,
          labelIntervalExpr: presets.segment.labelIntervalExpr, maxValueExpr: presets.segment.maxValueExpr,
          divisionPercents: [...presets.segment.divisionPercents], rotation: 0, ...style,
        };
      default:
        return null;
    }
  }, [presets, settings.defaultFill, settings.defaultStroke, settings.defaultStrokeWidth]);

  function chooseTool(tool: ToolId) {
    setActiveTool(tool);
    setSelectedId(null);
    setPolygonPoints([]);
    setInteraction(null);
    setZoomBox(null);
    setStatus(`${TOOL_LABELS[tool]}を選択しました`);
  }

  function beginPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    const objectElement = target.closest('[data-object-id]');
    const objectId = objectElement?.getAttribute('data-object-id') ?? null;

    if (activeTool === 'pan') {
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({ kind: 'pan', clientStart: { x: event.clientX, y: event.clientY }, originalView: view });
      return;
    }

    if (activeTool === 'zoom') {
      const point = rawWorldPoint(event.clientX, event.clientY);
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({ kind: 'zoom', start: point });
      setZoomBox({ start: point, end: point });
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
    if (interaction.kind === 'zoom') {
      setZoomBox({ start: interaction.start, end: rawWorldPoint(event.clientX, event.clientY) });
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

  function zoomAt(point: Point, factor: number) {
    const nextZoom = clamp(view.zoom * factor, 0.25, 8);
    const visibleWidth = project.canvas.width / nextZoom;
    const visibleHeight = project.canvas.height / nextZoom;
    setView({ x: point.x - visibleWidth / 2, y: point.y - visibleHeight / 2, zoom: nextZoom });
  }

  function fitZoomRect(rect: { x: number; y: number; width: number; height: number }) {
    const aspect = project.canvas.width / project.canvas.height;
    const paddedWidth = Math.max(rect.width * 1.08, rect.height * aspect * 1.08, 10);
    const paddedHeight = paddedWidth / aspect;
    const nextZoom = clamp(project.canvas.width / paddedWidth, 0.25, 8);
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    setView({ x: center.x - paddedWidth / 2, y: center.y - paddedHeight / 2, zoom: nextZoom });
  }

  function endPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (!interaction) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (interaction.kind === 'zoom') {
      const end = rawWorldPoint(event.clientX, event.clientY);
      const rect = normalizeRect(interaction.start, end);
      if (rect.width < 8 / view.zoom && rect.height < 8 / view.zoom) zoomAt(end, event.shiftKey ? 1 / 1.5 : 1.5);
      else fitZoomRect(rect);
      setZoomBox(null);
      setInteraction(null);
      return;
    }
    if (interaction.kind === 'draw') {
      const object = project.objects.find((item) => item.id === interaction.objectId);
      if (object) {
        const bounds = getObjectBounds(object);
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
    const point = rawWorldPoint(event.clientX, event.clientY);
    const oldZoom = view.zoom;
    const nextZoom = clamp(oldZoom * (event.deltaY < 0 ? 1.12 : 0.89), 0.25, 8);
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
    const object: GraphicObject = { id: createId('polygon'), type: 'polygon', points: polygonPoints, rotation: 0, ...presets.polygon };
    mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelectedId(object.id);
    setPolygonPoints([]);
    setStatus('多角形を作成しました');
  }

  function addText(value: string, point: Point) {
    if (!value.trim()) return;
    const object: TextObject = {
      id: createId('text'), type: 'text', x: point.x, y: point.y, text: value.trim(),
      fontSize: presets.text.fontSize, fontWeight: 500, align: 'start',
      stroke: presets.text.stroke, fill: presets.text.fill, strokeWidth: presets.text.strokeWidth, opacity: presets.text.opacity,
    };
    mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelectedId(object.id);
  }

  function addMath(value: string, point: Point) {
    if (!value.trim()) return;
    const object: MathObject = {
      id: createId('math'), type: 'math', x: point.x, y: point.y,
      expression: sanitizeExpression(value.trim()), fontSize: presets.math.fontSize,
      stroke: presets.math.stroke, fill: presets.math.fill, strokeWidth: presets.math.strokeWidth, opacity: presets.math.opacity,
    };
    mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelectedId(object.id);
  }

  function addObjectFromCoordinates(tool: 'line' | 'arrow' | 'ellipse') {
    let object: GraphicObject;
    if (tool === 'line' || tool === 'arrow') {
      const preset = presets[tool];
      object = {
        id: createId(tool), type: tool,
        stroke: preset.stroke, fill: preset.fill, strokeWidth: preset.strokeWidth, opacity: preset.opacity,
        start: coordinateToWorld(preset.start), end: coordinateToWorld(preset.end),
        ...(tool === 'arrow' ? { arrowSize: presets.arrow.arrowSize } : {}),
      } as GraphicObject;
    } else {
      const preset = presets.ellipse;
      const center = coordinateToWorld(preset.center);
      object = {
        id: createId('ellipse'), type: 'ellipse', cx: center.x, cy: center.y,
        rx: Math.max(0.05, preset.rx) * coordinateUnitPx, ry: Math.max(0.05, preset.ry) * coordinateUnitPx,
        rotation: 0, stroke: preset.stroke, fill: preset.fill, strokeWidth: preset.strokeWidth, opacity: preset.opacity,
      } as EllipseObject;
    }
    mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelectedId(object.id);
    setStatus('座標の指定から作成しました');
  }

  function renderArray(object: ArrayObject) {
    const rows = clamp(Math.round(resolveNumber(object.rowsExpr, project.variables, 3)), 1, 50);
    const cols = clamp(Math.round(resolveNumber(object.colsExpr, project.variables, 4)), 1, 50);
    const cellWidth = object.width / cols;
    const cellHeight = object.height / rows;
    const symbolSize = Math.min(object.symbolSize, Math.abs(cellWidth) * 0.36, Math.abs(cellHeight) * 0.36);
    const symbols = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cx = object.x + cellWidth * (col + 0.5);
        const cy = object.y + cellHeight * (row + 0.5);
        const fill = object.fill === 'transparent' ? object.stroke : object.fill;
        if (object.symbol === 'circle') symbols.push(<circle key={`${row}-${col}`} cx={cx} cy={cy} r={symbolSize} fill={fill} stroke="none" />);
        else if (object.symbol === 'square') symbols.push(<rect key={`${row}-${col}`} x={cx - symbolSize} y={cy - symbolSize} width={symbolSize * 2} height={symbolSize * 2} fill={fill} stroke="none" />);
        else if (object.symbol === 'dot') symbols.push(<circle key={`${row}-${col}`} cx={cx} cy={cy} r={Math.max(2, symbolSize * 0.42)} fill={object.stroke} stroke="none" />);
        else symbols.push(<path key={`${row}-${col}`} d={`M ${cx - symbolSize} ${cy - symbolSize} L ${cx + symbolSize} ${cy + symbolSize} M ${cx + symbolSize} ${cy - symbolSize} L ${cx - symbolSize} ${cy + symbolSize}`} fill="none" stroke={object.stroke} strokeWidth={object.strokeWidth} />);
      }
    }
    return symbols;
  }

  function renderNumberLine(object: SegmentObject) {
    const maxValue = Math.max(0.0001, Math.abs(resolveNumber(object.maxValueExpr, project.variables, 10)));
    const tickInterval = Math.max(0, resolveNumber(object.tickIntervalExpr, project.variables, 1));
    const labelInterval = Math.max(0, resolveNumber(object.labelIntervalExpr, project.variables, 1));
    const labelValid = tickInterval === 0 ? labelInterval === 0 : labelInterval === 0 || Math.abs(labelInterval / tickInterval - Math.round(labelInterval / tickInterval)) < 1e-7;
    const dx = object.end.x - object.start.x;
    const dy = object.end.y - object.start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const normal = { x: -dy / length, y: dx / length };
    const ticks = [];
    const tickCount = tickInterval > 0 ? Math.min(300, Math.floor(maxValue / tickInterval + 1e-9)) : 0;
    for (let index = 0; index <= tickCount; index += 1) {
      const value = index * tickInterval;
      const ratio = value / maxValue;
      const x = object.start.x + dx * ratio;
      const y = object.start.y + dy * ratio;
      const major = index === 0 || Math.abs(value - maxValue) < 1e-7;
      const half = major ? 11 : 7;
      const showLabel = labelValid && (value === 0 || (labelInterval > 0 && Math.abs(value / labelInterval - Math.round(value / labelInterval)) < 1e-7));
      ticks.push(
        <g key={`${index}-${value}`}>
          <line x1={x - normal.x * half} y1={y - normal.y * half} x2={x + normal.x * half} y2={y + normal.y * half} />
          {showLabel && <text x={x + normal.x * 25} y={y + normal.y * 25} textAnchor="middle" dominantBaseline="middle" fontSize={16} fill={object.stroke} stroke="none">{roundValue(value)}</text>}
        </g>,
      );
    }
    if (tickInterval === 0) {
      ticks.push(<text key="origin" x={object.start.x + normal.x * 25} y={object.start.y + normal.y * 25} textAnchor="middle" dominantBaseline="middle" fontSize={16} fill={object.stroke} stroke="none">0</text>);
    }
    return ticks;
  }

  function renderMeasure(object: SegmentObject) {
    if (object.mode === 'numberLine') {
      return <g><line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} />{renderNumberLine(object)}</g>;
    }
    const dx = object.end.x - object.start.x;
    const dy = object.end.y - object.start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const unit = { x: dx / length, y: dy / length };
    const normal = { x: -unit.y, y: unit.x };
    const percentages = object.divisionPercents.map((value) => clamp(value, 0, 100));
    let cumulative = 0;
    const points = percentages.map((percent) => {
      cumulative += percent;
      return Math.min(cumulative, 100);
    }).filter((percent) => percent < 99.999);
    const maxValue = resolveNumber(object.maxValueExpr, project.variables, 10);
    if (object.mode === 'tape') {
      const height = 42;
      const corners = [
        { x: object.start.x - normal.x * height / 2, y: object.start.y - normal.y * height / 2 },
        { x: object.end.x - normal.x * height / 2, y: object.end.y - normal.y * height / 2 },
        { x: object.end.x + normal.x * height / 2, y: object.end.y + normal.y * height / 2 },
        { x: object.start.x + normal.x * height / 2, y: object.start.y + normal.y * height / 2 },
      ];
      return (
        <g>
          <polygon points={corners.map((point) => `${point.x},${point.y}`).join(' ')} fill={object.fill === 'transparent' ? '#eef1ff' : object.fill} />
          {points.map((percent) => {
            const x = object.start.x + dx * percent / 100;
            const y = object.start.y + dy * percent / 100;
            return <line key={percent} x1={x - normal.x * height / 2} y1={y - normal.y * height / 2} x2={x + normal.x * height / 2} y2={y + normal.y * height / 2} />;
          })}
          <text x={object.end.x + normal.x * 34} y={object.end.y + normal.y * 34} textAnchor="middle" dominantBaseline="middle" fontSize={16} fill={object.stroke} stroke="none">{maxValue}</text>
        </g>
      );
    }
    return (
      <g>
        <line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} />
        {[0, ...points, 100].map((percent) => {
          const x = object.start.x + dx * percent / 100;
          const y = object.start.y + dy * percent / 100;
          const half = percent === 0 || percent === 100 ? 12 : 8;
          return <line key={percent} x1={x - normal.x * half} y1={y - normal.y * half} x2={x + normal.x * half} y2={y + normal.y * half} />;
        })}
        <text x={object.end.x + normal.x * 27} y={object.end.y + normal.y * 27} textAnchor="middle" dominantBaseline="middle" fontSize={16} fill={object.stroke} stroke="none">{maxValue}</text>
      </g>
    );
  }

  function renderArrow(object: LineObject) {
    const size = Math.max(4, object.arrowSize ?? 14);
    const dx = object.end.x - object.start.x;
    const dy = object.end.y - object.start.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;
    const base = { x: object.end.x - ux * size, y: object.end.y - uy * size };
    const half = size * 0.45;
    const points = `${object.end.x},${object.end.y} ${base.x + nx * half},${base.y + ny * half} ${base.x - nx * half},${base.y - ny * half}`;
    return <g><line x1={object.start.x} y1={object.start.y} x2={base.x} y2={base.y} fill="none" /><polygon points={points} fill={object.stroke} stroke={object.stroke} /></g>;
  }

  function objectTransform(object: GraphicObject): string | undefined {
    if (!('rotation' in object) || !object.rotation) return undefined;
    const bounds = getObjectBounds(object);
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    return `rotate(${object.rotation * 180 / Math.PI} ${center.x} ${center.y})`;
  }

  function renderObject(object: GraphicObject) {
    if (object.hidden) return null;
    const common = { stroke: object.stroke, fill: object.fill, strokeWidth: object.strokeWidth, opacity: object.opacity, vectorEffect: 'non-scaling-stroke' as const };
    const transform = objectTransform(object);
    const hitStroke = Math.max(14 / view.zoom, object.strokeWidth * 4);
    const content = (() => {
      switch (object.type) {
        case 'pen': return <path d={pointsToPath(object.points)} {...common} fill="none" strokeLinecap="round" strokeLinejoin="round" transform={transform} />;
        case 'line': return <line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} {...common} fill="none" />;
        case 'arrow': return <g {...common}>{renderArrow(object)}</g>;
        case 'rectangle': return <rect x={object.x} y={object.y} width={object.width} height={object.height} rx={object.radius} {...common} transform={transform} />;
        case 'ellipse': return <ellipse cx={object.cx} cy={object.cy} rx={object.rx} ry={object.ry} {...common} transform={transform} />;
        case 'polygon': return <polygon points={object.points.map((point) => `${point.x},${point.y}`).join(' ')} {...common} transform={transform} />;
        case 'text': return <text x={object.x} y={object.y} fontSize={object.fontSize} fontWeight={object.fontWeight} textAnchor={object.align} fill={object.stroke} stroke="none" opacity={object.opacity}>{object.text}</text>;
        case 'math': return <text x={object.x} y={object.y} fontSize={object.fontSize} fontFamily="Georgia, 'Times New Roman', serif" fontStyle="italic" fill={object.stroke} stroke="none" opacity={object.opacity}>{prettyMath(object.expression)}</text>;
        case 'array': return <g opacity={object.opacity} transform={transform}>{renderArray(object)}</g>;
        case 'segment': return <g {...common} fill="none">{renderMeasure(object)}</g>;
      }
    })();
    const hit = (() => {
      switch (object.type) {
        case 'line': case 'arrow': case 'segment': return <line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} stroke="transparent" strokeWidth={hitStroke} />;
        case 'pen': return <path d={pointsToPath(object.points)} fill="none" stroke="transparent" strokeWidth={hitStroke} transform={transform} />;
        default: {
          const bounds = getObjectBounds(object);
          return <rect x={bounds.x - 5} y={bounds.y - 5} width={Math.max(10, bounds.width + 10)} height={Math.max(10, bounds.height + 10)} fill="transparent" stroke="none" />;
        }
      }
    })();
    return <g key={object.id} data-object-id={object.id} className={object.locked ? 'object-locked' : ''}>{content}{hit}</g>;
  }

  function selectionOverlay() {
    if (!selectedObject) return null;
    const bounds = getObjectBounds(selectedObject);
    const pad = 8 / view.zoom;
    return <g data-ui-only="true" pointerEvents="none"><rect x={bounds.x - pad} y={bounds.y - pad} width={Math.max(1, bounds.width + pad * 2)} height={Math.max(1, bounds.height + pad * 2)} fill="none" stroke="#6455ea" strokeWidth={1.6} strokeDasharray="7 5" className="selection-outline" vectorEffect="non-scaling-stroke" /></g>;
  }

  function renderAxes() {
    if (!project.canvas.axesVisible) return null;
    const visible = { xMin: view.x, xMax: view.x + project.canvas.width / view.zoom, yMin: view.y, yMax: view.y + project.canvas.height / view.zoom };
    const tick = Math.max(0, project.canvas.tickInterval);
    const label = Math.max(0, project.canvas.labelInterval);
    const labelValid = tick === 0 ? label === 0 : label === 0 || Math.abs(label / tick - Math.round(label / tick)) < 1e-7;
    const elements: React.ReactNode[] = [];
    elements.push(<line key="x-axis" x1={visible.xMin} y1={coordinateOrigin.y} x2={visible.xMax} y2={coordinateOrigin.y} stroke="#596176" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />);
    elements.push(<line key="y-axis" x1={coordinateOrigin.x} y1={visible.yMin} x2={coordinateOrigin.x} y2={visible.yMax} stroke="#596176" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />);
    const arrowSize = 8 / view.zoom;
    elements.push(<path key="x-arrow" d={`M ${visible.xMax - arrowSize * 1.8} ${coordinateOrigin.y - arrowSize} L ${visible.xMax} ${coordinateOrigin.y} L ${visible.xMax - arrowSize * 1.8} ${coordinateOrigin.y + arrowSize}`} fill="none" stroke="#596176" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />);
    elements.push(<path key="y-arrow" d={`M ${coordinateOrigin.x - arrowSize} ${visible.yMin + arrowSize * 1.8} L ${coordinateOrigin.x} ${visible.yMin} L ${coordinateOrigin.x + arrowSize} ${visible.yMin + arrowSize * 1.8}`} fill="none" stroke="#596176" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />);
    if (tick > 0) {
      const xCoordMin = Math.floor((visible.xMin - coordinateOrigin.x) / coordinateUnitPx / tick) * tick;
      const xCoordMax = Math.ceil((visible.xMax - coordinateOrigin.x) / coordinateUnitPx / tick) * tick;
      const yCoordMin = Math.floor((coordinateOrigin.y - visible.yMax) / coordinateUnitPx / tick) * tick;
      const yCoordMax = Math.ceil((coordinateOrigin.y - visible.yMin) / coordinateUnitPx / tick) * tick;
      const xCount = Math.min(500, Math.ceil((xCoordMax - xCoordMin) / tick));
      const yCount = Math.min(500, Math.ceil((yCoordMax - yCoordMin) / tick));
      for (let index = 0; index <= xCount; index += 1) {
        const value = xCoordMin + index * tick;
        if (Math.abs(value) < 1e-8) continue;
        const x = coordinateOrigin.x + value * coordinateUnitPx;
        const half = 5 / view.zoom;
        elements.push(<line key={`xt-${index}`} x1={x} y1={coordinateOrigin.y - half} x2={x} y2={coordinateOrigin.y + half} stroke="#596176" strokeWidth={1} vectorEffect="non-scaling-stroke" />);
        if (labelValid && label > 0 && Math.abs(value / label - Math.round(value / label)) < 1e-7) elements.push(<text key={`xl-${index}`} x={x} y={coordinateOrigin.y + 20 / view.zoom} textAnchor="middle" fontSize={13 / view.zoom} fill="#444c61">{roundValue(value)}</text>);
      }
      for (let index = 0; index <= yCount; index += 1) {
        const value = yCoordMin + index * tick;
        if (Math.abs(value) < 1e-8) continue;
        const y = coordinateOrigin.y - value * coordinateUnitPx;
        const half = 5 / view.zoom;
        elements.push(<line key={`yt-${index}`} x1={coordinateOrigin.x - half} y1={y} x2={coordinateOrigin.x + half} y2={y} stroke="#596176" strokeWidth={1} vectorEffect="non-scaling-stroke" />);
        if (labelValid && label > 0 && Math.abs(value / label - Math.round(value / label)) < 1e-7) elements.push(<text key={`yl-${index}`} x={coordinateOrigin.x - 10 / view.zoom} y={y + 4 / view.zoom} textAnchor="end" fontSize={13 / view.zoom} fill="#444c61">{roundValue(value)}</text>);
      }
    }
    elements.push(<text key="origin-label" x={coordinateOrigin.x - 8 / view.zoom} y={coordinateOrigin.y + 17 / view.zoom} textAnchor="end" fontSize={13 / view.zoom} fill="#444c61">0</text>);
    return <g data-ui-only="true" pointerEvents="none">{elements}</g>;
  }

  const viewBox = `${view.x} ${view.y} ${project.canvas.width / view.zoom} ${project.canvas.height / view.zoom}`;
  const coordinateGridStep = coordinateUnitPx * Math.max(project.canvas.tickInterval || 1, 0.0001);

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
      setProject(normalizeProject(data));
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
      setSettings(normalizeSettings(data));
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
    mutateProject((current) => ({ ...current, variables: current.variables.map((variable) => variable.id === id ? { ...variable, ...patch } : variable) }), addHistory);
  }

  function addExpression() {
    const expression: ExpressionDef = { id: createId('expr'), label: `式${project.expressions.length + 1}`, source: '', visible: true };
    mutateProject((current) => ({ ...current, expressions: [...current.expressions, expression] }));
  }

  function updateExpression(id: string, patch: Partial<ExpressionDef>, addHistory = true) {
    mutateProject((current) => ({ ...current, expressions: current.expressions.map((expression) => expression.id === id ? { ...expression, ...patch } : expression) }), addHistory);
  }

  function placeExpression(expression: ExpressionDef) {
    setModal({ kind: 'math', point: { x: view.x + project.canvas.width / view.zoom / 2, y: view.y + project.canvas.height / view.zoom / 2 }, value: expression.source });
  }

  return (
    <div className={`app-shell ${presentation ? 'presentation-mode' : ''}`}>
      <header className="menu-bar">
        <button type="button" className="app-mark" aria-label="Graphantaについて" onClick={() => setModal({ kind: 'about' })}>
          <svg viewBox="0 0 40 40" aria-hidden="true"><path d="M8 31V9M8 31H33" /><path d="M11 27C15 24 17 14 22 18C26 21 27 10 32 9" /><circle cx="22" cy="18" r="2.2" /></svg>
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
        <div className="view-control" aria-label="表示倍率"><button type="button" onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>全体表示</button><output>{Math.round(view.zoom * 100)}%</output></div>
        <input className="project-title" value={project.title} aria-label="プロジェクト名" title="プロジェクト名" onChange={(event) => setProject((current) => ({ ...current, title: event.target.value }))} />
        <button type="button" className="wordmark" onClick={() => setModal({ kind: 'about' })}><strong>Graphanta</strong><span>visual mathematics</span></button>
      </header>

      <main className={`workspace toolbar-${settings.toolbarSide} ${panelCollapsed.tweak && panelCollapsed.expressions ? 'panels-collapsed' : ''}`}>
        {settings.toolbarSide === 'left' && <Toolbar tools={visibleTools} activeTool={activeTool} side="left" onChange={chooseTool} />}
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
                if (activeTool !== 'polygon') return;
                setPolygonPoints((points) => {
                  const cleaned = points.length >= 2 ? points.slice(0, -1) : points;
                  if (cleaned.length >= 3) {
                    const object: GraphicObject = { id: createId('polygon'), type: 'polygon', points: cleaned, rotation: 0, ...presets.polygon };
                    mutateProject((current) => ({ ...current, objects: [...current.objects, object] }));
                    setSelectedId(object.id);
                    setStatus('多角形を作成しました');
                    return [];
                  }
                  return points;
                });
              }}
            >
              <defs>
                <pattern id="pixel-small-grid" width={project.canvas.gridSize} height={project.canvas.gridSize} patternUnits="userSpaceOnUse"><path d={`M ${project.canvas.gridSize} 0 L 0 0 0 ${project.canvas.gridSize}`} fill="none" stroke="#e5e8f1" strokeWidth={0.7} vectorEffect="non-scaling-stroke" /></pattern>
                <pattern id="pixel-grid" width={project.canvas.gridSize * 5} height={project.canvas.gridSize * 5} patternUnits="userSpaceOnUse"><rect width={project.canvas.gridSize * 5} height={project.canvas.gridSize * 5} fill="url(#pixel-small-grid)" /><path d={`M ${project.canvas.gridSize * 5} 0 L 0 0 0 ${project.canvas.gridSize * 5}`} fill="none" stroke="#cbd2e0" strokeWidth={1.1} vectorEffect="non-scaling-stroke" /></pattern>
                <pattern id="coordinate-grid" x={coordinateOrigin.x} y={coordinateOrigin.y} width={coordinateGridStep} height={coordinateGridStep} patternUnits="userSpaceOnUse"><path d={`M ${coordinateGridStep} 0 L 0 0 0 ${coordinateGridStep}`} fill="none" stroke="#dfe4f0" strokeWidth={0.8} vectorEffect="non-scaling-stroke" /></pattern>
              </defs>
              <rect x={view.x} y={view.y} width={project.canvas.width / view.zoom} height={project.canvas.height / view.zoom} fill={project.canvas.background} />
              {project.canvas.gridVisible && <rect x={view.x} y={view.y} width={project.canvas.width / view.zoom} height={project.canvas.height / view.zoom} fill={project.canvas.axesVisible ? 'url(#coordinate-grid)' : 'url(#pixel-grid)'} />}
              {renderAxes()}
              {project.objects.map(renderObject)}
              {polygonPoints.length > 0 && <g data-ui-only="true" pointerEvents="none"><polyline points={polygonPoints.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#6d5dfc" strokeWidth={2} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />{polygonPoints.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={5 / view.zoom} fill="#6d5dfc" />)}</g>}
              {zoomBox && <rect data-ui-only="true" pointerEvents="none" {...normalizeRect(zoomBox.start, zoomBox.end)} fill="rgba(86,72,223,.12)" stroke="#5648df" strokeWidth={1.5} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />}
              {selectionOverlay()}
            </svg>
          </div>
          <footer className="status-bar"><span><strong>{TOOL_LABELS[activeTool]}</strong>　{status}</span><span>{project.objects.length}要素・オフライン保存</span></footer>
        </section>
        {settings.toolbarSide === 'right' && <Toolbar tools={visibleTools} activeTool={activeTool} side="right" onChange={chooseTool} />}

        <aside className="side-panels">
          <section className={`side-panel tweak-panel ${panelCollapsed.tweak ? 'collapsed' : ''}`}>
            <button type="button" className="panel-heading" aria-expanded={!panelCollapsed.tweak} title={panelCollapsed.tweak ? 'ツウィークを開く' : 'ツウィークを畳む'} onClick={() => setPanelCollapsed((current) => ({ ...current, tweak: !current.tweak }))}><span className="panel-title">ツウィーク</span><span className="panel-short">T</span><Icon name="chevron" size={18} /></button>
            {!panelCollapsed.tweak && <div className="panel-content tweak-content"><TweakPanel
              project={project}
              activeTool={activeTool}
              selected={selectedObject}
              presets={presets}
              coordinateUnitPx={coordinateUnitPx}
              worldToCoordinate={worldToCoordinate}
              coordinateToWorld={coordinateToWorld}
              onPresetChange={(tool, patch) => setPresets((current) => ({ ...current, [tool]: { ...current[tool], ...patch } }))}
              onCanvasChange={(patch) => mutateProject((current) => ({ ...current, canvas: { ...current.canvas, ...patch } }))}
              onObjectChange={(updater) => selectedObject && updateObject(selectedObject.id, updater)}
              onDelete={deleteSelected}
              onDuplicate={duplicateSelected}
              onFinalizePolygon={finalizePolygon}
              polygonCount={polygonPoints.length}
              onCreateFromCoordinates={addObjectFromCoordinates}
            /></div>}
          </section>
          <section className={`side-panel expression-panel ${panelCollapsed.expressions ? 'collapsed' : ''}`}>
            <button type="button" className="panel-heading" aria-expanded={!panelCollapsed.expressions} title={panelCollapsed.expressions ? 'fウィンドウを開く' : 'fウィンドウを畳む'} onClick={() => setPanelCollapsed((current) => ({ ...current, expressions: !current.expressions }))}><span className="panel-title">f　数式・変数</span><span className="panel-short">f</span><Icon name="chevron" size={18} /></button>
            {!panelCollapsed.expressions && <div className="panel-content"><ExpressionPanel
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
            /></div>}
          </section>
        </aside>
      </main>

      {presentation && <button className="exit-presentation" type="button" onClick={togglePresentation}>発表モードを終了</button>}
      <input ref={projectInputRef} type="file" accept=".json,.graphanta.json,application/json" hidden onChange={loadProjectFile} />
      <input ref={settingsInputRef} type="file" accept=".json,.graphanta-settings.json,application/json" hidden onChange={loadSettingsFile} />

      {modal?.kind === 'settings' && <Modal title="環境設定" wide onClose={() => setModal(null)}><SettingsEditor settings={settings} onChange={(next) => setSettings(normalizeSettings(next))} onSave={() => downloadJson('graphanta-settings.json', settings)} onLoad={() => settingsInputRef.current?.click()} onReset={() => setSettings(createDefaultSettings())} /></Modal>}
      {modal?.kind === 'text' && <Modal title="文字を追加" onClose={() => setModal(null)}><TextEntry initial={modal.value} onSubmit={(value) => { addText(value, modal.point); setModal(null); }} onCancel={() => setModal(null)} /></Modal>}
      {modal?.kind === 'math' && <Modal title="数式ウィンドウ" wide onClose={() => setModal(null)}><MathEditor initial={modal.value} onSubmit={(value) => { if (modal.expressionId) updateExpression(modal.expressionId, { source: sanitizeExpression(value) }); else addMath(value, modal.point); setModal(null); }} onCancel={() => setModal(null)} /></Modal>}
      {modal?.kind === 'about' && <Modal title="Graphanta" onClose={() => setModal(null)}><div className="about-box"><div className="about-logo">G</div><p><strong>Graphanta {APP_VERSION}</strong></p><p>数学的な思考と表現を、速く・簡単に・見やすく支えるローカルファーストの作図環境です。</p></div></Modal>}
    </div>
  );
}

interface TweakPanelProps {
  project: GraphantaProject;
  activeTool: ToolId;
  selected: GraphicObject | null;
  presets: ToolPresets;
  coordinateUnitPx: number;
  worldToCoordinate: (point: Point) => Point;
  coordinateToWorld: (point: Point) => Point;
  onPresetChange: <K extends keyof ToolPresets>(tool: K, patch: Partial<ToolPresets[K]>) => void;
  onCanvasChange: (patch: Partial<GraphantaProject['canvas']>) => void;
  onObjectChange: (updater: (object: GraphicObject) => GraphicObject) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onFinalizePolygon: () => void;
  polygonCount: number;
  onCreateFromCoordinates: (tool: 'line' | 'arrow' | 'ellipse') => void;
}

function TweakPanel(props: TweakPanelProps) {
  const { project, activeTool, selected, presets, coordinateUnitPx, worldToCoordinate, coordinateToWorld, onPresetChange, onCanvasChange, onObjectChange, onDelete, onDuplicate, onFinalizePolygon, polygonCount, onCreateFromCoordinates } = props;
  const navigationMode = activeTool === 'select' || activeTool === 'pan' || activeTool === 'zoom';
  const showSelected = Boolean(selected) && activeTool !== 'pan' && activeTool !== 'zoom' && (activeTool === 'select' || (selected ? toolForObject(selected) === activeTool : false));
  const patchObject = (changes: Partial<GraphicObject>) => onObjectChange((object) => ({ ...object, ...changes } as GraphicObject));

  if (navigationMode && !showSelected) {
    const tick = project.canvas.tickInterval;
    const label = project.canvas.labelInterval;
    const labelError = project.canvas.axesVisible && label > 0 && (tick <= 0 || Math.abs(label / tick - Math.round(label / tick)) > 1e-7);
    return (
      <>
        <Field label="背景色"><input type="color" value={project.canvas.background} onChange={(event) => onCanvasChange({ background: event.target.value })} /></Field>
        <div className="display-mode" role="group" aria-label="背景表示">
          <button type="button" className={!project.canvas.gridVisible && !project.canvas.axesVisible ? 'is-active' : ''} title="白紙" onClick={() => onCanvasChange({ gridVisible: false, axesVisible: false })}><Icon name="blank" /><span>白紙</span></button>
          <button type="button" className={project.canvas.gridVisible ? 'is-active' : ''} title="方眼" onClick={() => onCanvasChange({ gridVisible: !project.canvas.gridVisible })}><Icon name="grid" /><span>方眼</span></button>
          <button type="button" className={project.canvas.axesVisible ? 'is-active' : ''} title="座標" onClick={() => onCanvasChange({ axesVisible: !project.canvas.axesVisible })}><Icon name="axes" /><span>座標</span></button>
        </div>
        {project.canvas.axesVisible ? (
          <>
            <Field label="目盛り"><AsciiNumber value={project.canvas.tickInterval} min={0} step={0.1} onChange={(value) => onCanvasChange({ tickInterval: Math.max(0, value) })} /></Field>
            <Field label="数値"><AsciiNumber value={project.canvas.labelInterval} min={0} step={0.1} invalid={labelError} onChange={(value) => onCanvasChange({ labelInterval: Math.max(0, value) })} /></Field>
            {labelError && <p className="field-error">「数値」は「目盛り」の整数倍にしてください。</p>}
            <Field label="精度"><AsciiNumber value={project.canvas.coordinatePrecision} min={1} max={10000} step={1} onChange={(value) => onCanvasChange({ coordinatePrecision: clamp(value, 1, 10000) })} /></Field>
            <Toggle label="吸着" checked={project.canvas.snapGrid} onChange={(checked) => onCanvasChange({ snapGrid: checked })} />
          </>
        ) : project.canvas.gridVisible ? (
          <>
            <Field label="方眼間隔"><AsciiNumber value={project.canvas.gridSize} min={5} max={200} step={1} onChange={(value) => onCanvasChange({ gridSize: clamp(value, 5, 200) })} /></Field>
            <Toggle label="吸着" checked={project.canvas.snapGrid} onChange={(checked) => onCanvasChange({ snapGrid: checked })} />
          </>
        ) : null}
      </>
    );
  }

  if (showSelected && selected) {
    return <SelectedObjectEditor object={selected} coordinateUnitPx={coordinateUnitPx} worldToCoordinate={worldToCoordinate} coordinateToWorld={coordinateToWorld} onPatch={patchObject} onChange={onObjectChange} onDelete={onDelete} onDuplicate={onDuplicate} />;
  }

  if (activeTool === 'pen') return <><PresetHeader label="フリーハンド" /><LineStyleEditor value={presets.pen} onChange={(patch) => onPresetChange('pen', patch)} /></>;
  if (activeTool === 'line' || activeTool === 'arrow') {
    const preset = presets[activeTool];
    return (
      <>
        <PresetHeader label={TOOL_LABELS[activeTool]} />
        <LineStyleEditor value={preset} onChange={(patch) => onPresetChange(activeTool, patch)} />
        <PointField label="始点" value={preset.start} onChange={(point) => onPresetChange(activeTool, { start: point })} />
        <PointField label="終点" value={preset.end} onChange={(point) => onPresetChange(activeTool, { end: point })} />
        {activeTool === 'arrow' && <Field label="矢じり"><input type="range" min="4" max="60" step="1" value={presets.arrow.arrowSize} onChange={(event) => onPresetChange('arrow', { arrowSize: Number(event.target.value) })} /><output>{presets.arrow.arrowSize}</output></Field>}
        <button type="button" className="primary-button full" onClick={() => onCreateFromCoordinates(activeTool)}>座標から作成</button>
      </>
    );
  }
  if (activeTool === 'rectangle') return <><PresetHeader label="四角形" /><ShapeStyleEditor value={presets.rectangle} onChange={(patch) => onPresetChange('rectangle', patch)} /><Field label="角の丸み"><AsciiNumber value={presets.rectangle.radius} min={0} max={100} onChange={(value) => onPresetChange('rectangle', { radius: value })} /></Field></>;
  if (activeTool === 'ellipse') {
    return (
      <>
        <PresetHeader label="円・だ円" />
        <ShapeStyleEditor value={presets.ellipse} onChange={(patch) => onPresetChange('ellipse', patch)} />
        <PointField label="中心" value={presets.ellipse.center} onChange={(center) => onPresetChange('ellipse', { center })} />
        <Field label="半径X"><RangeNumber value={presets.ellipse.rx} min={0.1} max={20} step={0.1} onChange={(rx) => onPresetChange('ellipse', { rx })} /></Field>
        <Field label="半径Y"><RangeNumber value={presets.ellipse.ry} min={0.1} max={20} step={0.1} onChange={(ry) => onPresetChange('ellipse', { ry })} /></Field>
        <button type="button" className="primary-button full" onClick={() => onCreateFromCoordinates('ellipse')}>数値から作成</button>
      </>
    );
  }
  if (activeTool === 'polygon') return <><PresetHeader label="多角形" /><ShapeStyleEditor value={presets.polygon} onChange={(patch) => onPresetChange('polygon', patch)} />{polygonCount > 0 && <button type="button" className="primary-button full" onClick={onFinalizePolygon} disabled={polygonCount < 3}>多角形を確定（{polygonCount}点）</button>}</>;
  if (activeTool === 'text') return <><PresetHeader label="文字" /><LineStyleEditor value={presets.text} onChange={(patch) => onPresetChange('text', patch)} /><Field label="文字サイズ"><RangeNumber value={presets.text.fontSize} min={8} max={160} step={1} onChange={(fontSize) => onPresetChange('text', { fontSize })} /></Field></>;
  if (activeTool === 'math') return <><PresetHeader label="数式" /><LineStyleEditor value={presets.math} onChange={(patch) => onPresetChange('math', patch)} /><Field label="文字サイズ"><RangeNumber value={presets.math.fontSize} min={8} max={160} step={1} onChange={(fontSize) => onPresetChange('math', { fontSize })} /></Field></>;
  if (activeTool === 'array') return <><PresetHeader label="アレー図" /><LineStyleEditor value={presets.array} onChange={(patch) => onPresetChange('array', patch)} /><ArrayFields value={presets.array} onChange={(patch) => onPresetChange('array', patch)} /></>;
  if (activeTool === 'segment') return <><PresetHeader label="目盛り" /><LineStyleEditor value={presets.segment} onChange={(patch) => onPresetChange('segment', patch)} /><MeasureFields value={presets.segment} onChange={(patch) => onPresetChange('segment', patch)} /></>;
  return null;
}

function PresetHeader({ label }: { label: string }) {
  return <div className="preset-header"><strong>{label}</strong><span>描画前の設定</span></div>;
}

function LineStyleEditor({ value, onChange }: { value: StylePreset; onChange: (patch: Partial<StylePreset>) => void }) {
  return (
    <>
      <Field label="線の色"><input type="color" value={value.stroke} onChange={(event) => onChange({ stroke: event.target.value })} /></Field>
      <Field label="線の太さ"><RangeNumber value={value.strokeWidth} min={0.5} max={12} step={0.5} onChange={(strokeWidth) => onChange({ strokeWidth })} /></Field>
      <Field label="不透明度"><RangeNumber value={value.opacity * 100} min={10} max={100} step={5} suffix="%" onChange={(opacity) => onChange({ opacity: opacity / 100 })} /></Field>
    </>
  );
}

function ShapeStyleEditor({ value, onChange }: { value: StylePreset; onChange: (patch: Partial<StylePreset>) => void }) {
  return (
    <>
      <LineStyleEditor value={value} onChange={onChange} />
      <Field label="塗りの色"><div className="fill-control"><input type="color" value={value.fill === 'transparent' ? '#ffffff' : value.fill} disabled={value.fill === 'transparent'} onChange={(event) => onChange({ fill: event.target.value })} /><Toggle label="透明" checked={value.fill === 'transparent'} onChange={(checked) => onChange({ fill: checked ? 'transparent' : '#dfe5ff' })} compact /></div></Field>
    </>
  );
}

function SelectedObjectEditor({ object, coordinateUnitPx, worldToCoordinate, coordinateToWorld, onPatch, onChange, onDelete, onDuplicate }: {
  object: GraphicObject;
  coordinateUnitPx: number;
  worldToCoordinate: (point: Point) => Point;
  coordinateToWorld: (point: Point) => Point;
  onPatch: (patch: Partial<GraphicObject>) => void;
  onChange: (updater: (object: GraphicObject) => GraphicObject) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const setRotation = (angle: number) => onChange((current) => {
    const next = normalizeAngle(angle);
    if (current.type === 'line' || current.type === 'arrow' || current.type === 'segment') {
      const center = { x: (current.start.x + current.end.x) / 2, y: (current.start.y + current.end.y) / 2 };
      const length = Math.hypot(current.end.x - current.start.x, current.end.y - current.start.y);
      const vector = { x: Math.cos(next) * length / 2, y: Math.sin(next) * length / 2 };
      return { ...current, start: { x: center.x - vector.x, y: center.y - vector.y }, end: { x: center.x + vector.x, y: center.y + vector.y } };
    }
    if ('rotation' in current) return { ...current, rotation: next } as GraphicObject;
    return current;
  });
  const rotation = object.type === 'line' || object.type === 'arrow' || object.type === 'segment' ? angleOf(object.start, object.end) : ('rotation' in object ? object.rotation ?? 0 : 0);
  const canRotate = object.type === 'pen' || object.type === 'line' || object.type === 'arrow' || object.type === 'rectangle' || object.type === 'ellipse' || object.type === 'segment';
  const circle = object.type === 'ellipse' && Math.abs(object.rx - object.ry) < 0.001;
  return (
    <>
      <div className="selected-type"><span>{TOOL_LABELS[toolForObject(object)]}</span><code>{object.id.slice(0, 8)}</code></div>
      <div className="inline-actions"><button type="button" onClick={onDuplicate}><Icon name="duplicate" size={18} />複製</button><button type="button" className="danger" onClick={onDelete}><Icon name="delete" size={18} />削除</button></div>
      {(object.type === 'rectangle' || object.type === 'ellipse' || object.type === 'polygon') ? <ShapeStyleEditor value={object} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} /> : <LineStyleEditor value={object} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} />}
      {canRotate && <RotationField value={rotation} disabled={circle} onChange={setRotation} />}
      <Toggle label="固定する" checked={Boolean(object.locked)} onChange={(checked) => onPatch({ locked: checked })} />
      {(object.type === 'line' || object.type === 'arrow') && <LineCoordinateFields object={object} worldToCoordinate={worldToCoordinate} coordinateToWorld={coordinateToWorld} onChange={onChange} />}
      {object.type === 'arrow' && <Field label="矢じり"><RangeNumber value={object.arrowSize ?? 14} min={4} max={60} step={1} onChange={(arrowSize) => onPatch({ arrowSize } as Partial<GraphicObject>)} /></Field>}
      {object.type === 'rectangle' && <Field label="角の丸み"><AsciiNumber value={object.radius} min={0} max={100} onChange={(radius) => onPatch({ radius } as Partial<GraphicObject>)} /></Field>}
      {object.type === 'ellipse' && <EllipseFields object={object} coordinateUnitPx={coordinateUnitPx} worldToCoordinate={worldToCoordinate} coordinateToWorld={coordinateToWorld} onChange={onChange} />}
      {object.type === 'text' && <><Field label="文字"><textarea value={object.text} onChange={(event) => onPatch({ text: event.target.value } as Partial<GraphicObject>)} /></Field><Field label="文字サイズ"><AsciiNumber value={object.fontSize} min={8} max={160} onChange={(fontSize) => onPatch({ fontSize } as Partial<GraphicObject>)} /></Field></>}
      {object.type === 'math' && <><Field label="数式"><AsciiText value={object.expression} onChange={(expression) => onPatch({ expression } as Partial<GraphicObject>)} /></Field><Field label="文字サイズ"><AsciiNumber value={object.fontSize} min={8} max={160} onChange={(fontSize) => onPatch({ fontSize } as Partial<GraphicObject>)} /></Field></>}
      {object.type === 'array' && <ArrayFields value={object} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} />}
      {object.type === 'segment' && <MeasureFields value={object} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} />}
    </>
  );
}

function RotationField({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <Field label="回転"><div className="range-direct"><input type="range" min={-Math.PI} max={Math.PI} step="0.01" value={normalizeAngle(value)} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /><AsciiNumber value={roundValue(normalizeAngle(value), 3)} min={-Math.PI} max={Math.PI} step={0.01} disabled={disabled} onChange={onChange} /><span>rad</span></div></Field>;
}

function LineCoordinateFields({ object, worldToCoordinate, coordinateToWorld, onChange }: { object: LineObject; worldToCoordinate: (point: Point) => Point; coordinateToWorld: (point: Point) => Point; onChange: (updater: (object: GraphicObject) => GraphicObject) => void }) {
  const start = worldToCoordinate(object.start);
  const end = worldToCoordinate(object.end);
  const setPoint = (key: 'start' | 'end', point: Point) => onChange((current) => current.type === 'line' || current.type === 'arrow' ? { ...current, [key]: coordinateToWorld(point) } : current);
  return <><PointField label="始点" value={start} onChange={(point) => setPoint('start', point)} /><PointField label="終点" value={end} onChange={(point) => setPoint('end', point)} /></>;
}

function EllipseFields({ object, coordinateUnitPx, worldToCoordinate, coordinateToWorld, onChange }: { object: EllipseObject; coordinateUnitPx: number; worldToCoordinate: (point: Point) => Point; coordinateToWorld: (point: Point) => Point; onChange: (updater: (object: GraphicObject) => GraphicObject) => void }) {
  const center = worldToCoordinate({ x: object.cx, y: object.cy });
  const rx = object.rx / coordinateUnitPx;
  const ry = object.ry / coordinateUnitPx;
  const isCircle = Math.abs(rx - ry) < 0.001;
  const major = Math.max(rx, ry);
  const minor = Math.min(rx, ry);
  const eccentricity = major > 0 ? Math.sqrt(Math.max(0, 1 - (minor * minor) / (major * major))) : 0;
  const patch = (changes: Partial<EllipseObject>) => onChange((current) => current.type === 'ellipse' ? { ...current, ...changes } : current);
  const setCenter = (point: Point) => { const world = coordinateToWorld(point); patch({ cx: world.x, cy: world.y }); };
  if (isCircle) return <><PointField label="中心" value={center} onChange={setCenter} /><Field label="半径"><RangeNumber value={roundValue(rx)} min={0.1} max={50} step={0.1} onChange={(radius) => patch({ rx: radius * coordinateUnitPx, ry: radius * coordinateUnitPx })} /></Field></>;
  const setMajor = (value: number) => patch(rx >= ry ? { rx: value * coordinateUnitPx } : { ry: value * coordinateUnitPx });
  const setMinor = (value: number) => patch(rx >= ry ? { ry: Math.min(value, major) * coordinateUnitPx } : { rx: Math.min(value, major) * coordinateUnitPx });
  const setEccentricity = (value: number) => {
    const e = clamp(value, 0, 0.999);
    setMinor(major * Math.sqrt(1 - e * e));
  };
  return <><PointField label="中心" value={center} onChange={setCenter} /><Field label="長半径"><RangeNumber value={roundValue(major)} min={0.1} max={50} step={0.1} onChange={setMajor} /></Field><Field label="短半径"><RangeNumber value={roundValue(minor)} min={0.1} max={major} step={0.1} onChange={setMinor} /></Field><Field label="離心率"><RangeNumber value={roundValue(eccentricity, 3)} min={0} max={0.999} step={0.01} onChange={setEccentricity} /></Field></>;
}

function ArrayFields({ value, onChange }: { value: Pick<ArrayObject, 'rowsExpr' | 'colsExpr' | 'symbol' | 'symbolSize'>; onChange: (patch: Partial<ArrayObject>) => void }) {
  return <><Field label="行数"><AsciiText value={value.rowsExpr} onChange={(rowsExpr) => onChange({ rowsExpr })} /></Field><Field label="列数"><AsciiText value={value.colsExpr} onChange={(colsExpr) => onChange({ colsExpr })} /></Field><Field label="シンボル"><select value={value.symbol} onChange={(event) => onChange({ symbol: event.target.value as ArrayObject['symbol'] })}><option value="circle">円</option><option value="square">四角</option><option value="dot">点</option><option value="cross">×</option></select></Field><Field label="大きさ"><RangeNumber value={value.symbolSize} min={2} max={28} step={1} onChange={(symbolSize) => onChange({ symbolSize })} /></Field></>;
}

type MeasureValue = Pick<SegmentObject, 'mode' | 'tickIntervalExpr' | 'labelIntervalExpr' | 'maxValueExpr' | 'divisionPercents'>;

function rebalanceDivisions(values: number[], index: number, nextValue: number): number[] {
  const next = values.map((value) => clamp(value, 0, 100));
  next[index] = clamp(nextValue, 0, 100);
  const otherIndexes = next.map((_, itemIndex) => itemIndex).filter((itemIndex) => itemIndex !== index);
  const otherTotal = otherIndexes.reduce((sum, itemIndex) => sum + next[itemIndex], 0);
  const available = Math.max(0, 100 - next[index]);
  if (otherTotal > available && otherTotal > 0) {
    const factor = available / otherTotal;
    otherIndexes.forEach((itemIndex) => { next[itemIndex] = roundValue(next[itemIndex] * factor, 3); });
  }
  return next;
}

function MeasureFields({ value, onChange }: { value: MeasureValue; onChange: (patch: Partial<SegmentObject>) => void }) {
  const tick = Number(value.tickIntervalExpr) || 0;
  const label = Number(value.labelIntervalExpr) || 0;
  const invalid = value.mode === 'numberLine' && label > 0 && (tick <= 0 || Math.abs(label / tick - Math.round(label / tick)) > 1e-7);
  const setDivision = (index: number, nextValue: number) => onChange({ divisionPercents: rebalanceDivisions(value.divisionPercents, index, nextValue) });
  const addDivision = () => {
    const current = value.divisionPercents;
    const remaining = Math.max(0, 100 - current.reduce((sum, item) => sum + item, 0));
    if (remaining >= 10) onChange({ divisionPercents: [...current, Math.min(50, remaining)] });
    else {
      const scaled = current.map((item) => roundValue(item * 0.85, 3));
      onChange({ divisionPercents: [...scaled, roundValue(100 - scaled.reduce((sum, item) => sum + item, 0), 3)] });
    }
  };
  return (
    <>
      <div className="measure-mode" role="group" aria-label="目盛りの種類">
        <button type="button" className={value.mode === 'numberLine' ? 'is-active' : ''} onClick={() => onChange({ mode: 'numberLine' })}><Icon name="numberLine" /><span>数直線</span></button>
        <button type="button" className={value.mode === 'tape' ? 'is-active' : ''} onClick={() => onChange({ mode: 'tape' })}><Icon name="tape" /><span>テープ図</span></button>
        <button type="button" className={value.mode === 'segment' ? 'is-active' : ''} onClick={() => onChange({ mode: 'segment' })}><Icon name="measureSegment" /><span>線分図</span></button>
      </div>
      {value.mode === 'numberLine' ? <><Field label="目盛り"><AsciiText value={value.tickIntervalExpr} invalid={invalid && tick <= 0} onChange={(tickIntervalExpr) => onChange({ tickIntervalExpr })} /></Field><Field label="数値"><AsciiText value={value.labelIntervalExpr} invalid={invalid} onChange={(labelIntervalExpr) => onChange({ labelIntervalExpr })} /></Field>{invalid && <p className="field-error">「数値」は「目盛り」の整数倍にしてください。</p>}<Field label="最大値"><AsciiText value={value.maxValueExpr} onChange={(maxValueExpr) => onChange({ maxValueExpr })} /></Field></> : <><Field label="最大値"><AsciiText value={value.maxValueExpr} onChange={(maxValueExpr) => onChange({ maxValueExpr })} /></Field><div className="division-heading"><span>内分点</span><button type="button" onClick={addDivision}>＋</button></div>{value.divisionPercents.map((percent, index) => <Field key={index} label={`点${index + 1}`}><RangeNumber value={roundValue(percent, 2)} min={0} max={100} step={1} suffix="%" onChange={(next) => setDivision(index, next)} /><button type="button" className="mini-delete" aria-label={`点${index + 1}を削除`} onClick={() => onChange({ divisionPercents: value.divisionPercents.filter((_, itemIndex) => itemIndex !== index) })}>×</button></Field>)}</>}
    </>
  );
}

function PointField({ label, value, onChange }: { label: string; value: Point; onChange: (point: Point) => void }) {
  return <Field label={label}><div className="point-input"><label>x<AsciiNumber value={roundValue(value.x)} step={0.1} onChange={(x) => onChange({ ...value, x })} /></label><label>y<AsciiNumber value={roundValue(value.y)} step={0.1} onChange={(y) => onChange({ ...value, y })} /></label></div></Field>;
}

function RangeNumber({ value, min, max, step = 1, suffix = '', onChange }: { value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  return <div className="range-number"><input type="range" min={min} max={max} step={step} value={clamp(value, min, max)} onChange={(event) => onChange(Number(event.target.value))} /><AsciiNumber value={value} min={min} max={max} step={step} onChange={onChange} />{suffix && <span>{suffix}</span>}</div>;
}

function AsciiNumber({ value, min, max, step = 1, invalid = false, disabled = false, onChange }: { value: number; min?: number; max?: number; step?: number; invalid?: boolean; disabled?: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '0');
  useEffect(() => setText(Number.isFinite(value) ? String(value) : '0'), [value]);
  const commit = (candidate: string) => {
    let next = Number(candidate);
    if (!Number.isFinite(next)) next = Number.isFinite(value) ? value : 0;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setText(String(next));
    onChange(next);
  };
  return <input type="text" inputMode="decimal" className={invalid ? 'is-invalid' : ''} aria-invalid={invalid || undefined} disabled={disabled} value={text} onChange={(event) => {
    const normalized = sanitizeNumberText(event.target.value);
    setText(normalized);
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
      const next = Number(normalized);
      if (Number.isFinite(next)) onChange(next);
    }
  }} onBlur={() => commit(text)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(text); event.currentTarget.blur(); } }} data-step={step} />;
}

function AsciiText({ value, invalid = false, onChange }: { value: string; invalid?: boolean; onChange: (value: string) => void }) {
  return <input type="text" inputMode="text" className={invalid ? 'is-invalid' : ''} aria-invalid={invalid || undefined} value={value} onChange={(event) => onChange(sanitizeExpression(event.target.value))} />;
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
      <div className="variable-list">{project.variables.map((variable) => <article className="variable-card" key={variable.id}><div className="variable-head"><input className="variable-name" aria-label="変数名" value={variable.name} onChange={(event) => onUpdateVariable(variable.id, { name: sanitizeExpression(event.target.value).replace(/[^A-Za-z_]/g, '').slice(0, 8) })} /><output>{variable.value}</output><button type="button" className="mini-delete" onClick={() => onDeleteVariable(variable.id)}>×</button></div><input type="range" min={variable.min} max={variable.max} step={variable.step} value={variable.value} onPointerDown={onStartSliderHistory} onChange={(event) => onUpdateVariable(variable.id, { value: Number(event.target.value) }, false)} /><div className="variable-range"><label>最小<AsciiNumber value={variable.min} onChange={(min) => onUpdateVariable(variable.id, { min })} /></label><label>刻み<AsciiNumber value={variable.step} min={0.001} step={0.001} onChange={(step) => onUpdateVariable(variable.id, { step: Math.max(0.001, step) })} /></label><label>最大<AsciiNumber value={variable.max} onChange={(max) => onUpdateVariable(variable.id, { max })} /></label></div></article>)}</div>
      <div className="subheading"><span>数式</span><button type="button" onClick={onAddExpression}>＋追加</button></div>
      <div className="expression-list">{project.expressions.map((expression) => <article className="expression-card" key={expression.id}><div className="expression-head"><input type="checkbox" checked={expression.visible} onChange={(event) => onUpdateExpression(expression.id, { visible: event.target.checked })} aria-label="表示" /><input className="expression-label" value={expression.label} onChange={(event) => onUpdateExpression(expression.id, { label: event.target.value })} /><button type="button" className="mini-delete" onClick={() => onDeleteExpression(expression.id)}>×</button></div><input className="expression-source" placeholder="例: y=a*x^2" value={expression.source} onChange={(event) => onUpdateExpression(expression.id, { source: sanitizeExpression(event.target.value) }, false)} onBlur={(event) => onUpdateExpression(expression.id, { source: sanitizeExpression(event.target.value) })} /><div className="expression-preview">{prettyMath(expression.source) || '数式を入力'}</div><div className="expression-actions"><button type="button" onClick={() => onEditDetailed(expression)}>詳細入力</button><button type="button" onClick={() => onPlace(expression)} disabled={!expression.source.trim()}>配置</button></div></article>)}</div>
      <div className="function-placeholder"><Icon name="function" size={20} /><span>関数グラフ描画はv3で有効になります。</span></div>
    </>
  );
}

interface SettingsEditorProps { settings: GraphantaSettings; onChange: (settings: GraphantaSettings) => void; onSave: () => void; onLoad: () => void; onReset: () => void; }
function SettingsEditor({ settings, onChange, onSave, onLoad, onReset }: SettingsEditorProps) {
  const toggleTool = (tool: ToolId, checked: boolean) => {
    const visibleTools = checked ? [...new Set([...settings.visibleTools, tool])] : settings.visibleTools.filter((item) => item !== tool);
    onChange({ ...settings, visibleTools });
  };
  return <div className="settings-grid"><section><h3>レイアウト</h3><Field label="ツールバー位置"><select value={settings.toolbarSide} onChange={(event) => onChange({ ...settings, toolbarSide: event.target.value as 'left' | 'right' })}><option value="right">右側</option><option value="left">左側</option></select></Field><Toggle label="前回の作業を自動復旧" checked={settings.autoRestore} onChange={(autoRestore) => onChange({ ...settings, autoRestore })} /><h3>新規要素の初期値</h3><Field label="線の色"><input type="color" value={settings.defaultStroke} onChange={(event) => onChange({ ...settings, defaultStroke: event.target.value })} /></Field><Field label="線の太さ"><AsciiNumber value={settings.defaultStrokeWidth} min={0.5} max={12} step={0.5} onChange={(defaultStrokeWidth) => onChange({ ...settings, defaultStrokeWidth })} /></Field></section><section><h3>表示するツール</h3><div className="tool-settings-list">{ALL_TOOLS.map((tool) => <label key={tool} className="tool-setting"><input type="checkbox" checked={settings.visibleTools.includes(tool)} onChange={(event) => toggleTool(tool, event.target.checked)} /><Icon name={tool} size={20} /><span>{TOOL_LABELS[tool]}</span></label>)}</div></section><footer className="settings-footer"><button type="button" onClick={onSave}>環境設定を書き出す</button><button type="button" onClick={onLoad}>環境設定を読み込む</button><button type="button" className="danger" onClick={onReset}>初期設定に戻す</button></footer></div>;
}

function TextEntry({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit(value); }}><textarea className="large-entry" autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="表示する文字を入力" /><div className="modal-actions"><button type="button" onClick={onCancel}>キャンセル</button><button type="submit" className="primary-button" disabled={!value.trim()}>追加</button></div></form>;
}

function MathEditor({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(sanitizeExpression(initial));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const insert = (token: string, caretOffset = token.length) => {
    const textarea = textareaRef.current;
    if (!textarea) { setValue((current) => current + token); return; }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = value.slice(0, start) + token + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => { textarea.focus(); textarea.setSelectionRange(start + caretOffset, start + caretOffset); });
  };
  const palette = [{ label: '分数', token: '()/()', offset: 1 }, { label: '平方根', token: 'sqrt()', offset: 5 }, { label: '累乗', token: '^()', offset: 2 }, { label: '下付き', token: '_()', offset: 2 }, { label: 'π', token: 'pi', offset: 2 }, { label: '絶対値', token: 'abs()', offset: 4 }, { label: 'Σ', token: 'sum()', offset: 4 }, { label: '∫', token: 'int()', offset: 4 }, { label: '行列', token: 'matrix([,],[,])', offset: 8 }];
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit(value); }} className="math-editor"><div className="math-palette">{palette.map((item) => <button type="button" key={item.label} onClick={() => insert(item.token, item.offset)}>{item.label}</button>)}</div><div className="math-workspace"><textarea ref={textareaRef} autoFocus value={value} onChange={(event) => setValue(sanitizeExpression(event.target.value))} placeholder="例: y=a*x^2 / sqrt(2)" /><div className="math-live-preview"><span>プレビュー</span><strong>{prettyMath(value) || '—'}</strong></div></div><p className="math-help">半角英数と数式記号で入力します。構造入力用の記号パレットと軽量プレビューを実装しています。</p><div className="modal-actions"><button type="button" onClick={onCancel}>キャンセル</button><button type="submit" className="primary-button" disabled={!value.trim()}>確定</button></div></form>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span><div>{children}</div></label>; }
function Toggle({ label, checked, onChange, disabled = false, compact = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; compact?: boolean }) { return <label className={`toggle ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track"><span /></span><em>{label}</em></label>; }

export default App;
