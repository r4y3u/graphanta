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
import { createId, distance, normalizeRect, pointsToPath, translateObject } from './lib/geometry';
import { prettyMath, resolveNumber } from './lib/math';
import { captureSvgAsPng, composeFourCaptures, copySvgPngToClipboard, createPngPreviewWindow, openSvgAsPng, showPngInPreview, type PngCapture } from './lib/screenshot';
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
  PolygonObject,
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

interface ExpressionPoint { x: string; y: string; }

interface ToolPresets {
  pen: StylePreset;
  line: StylePreset & { start: ExpressionPoint; end: ExpressionPoint };
  arrow: StylePreset & { start: ExpressionPoint; end: ExpressionPoint; arrowSize: number };
  rectangle: StylePreset & { radius: number };
  ellipse: StylePreset & { center: ExpressionPoint; majorRadiusExpr: string; minorRadiusExpr: string; eccentricityExpr: string; majorAxis: 'x' | 'y' };
  polygon: StylePreset;
  text: StylePreset & { fontSize: number };
  math: StylePreset & { fontSize: number };
  array: StylePreset & { rowsExpr: string; colsExpr: string; symbol: ArrayObject['symbol']; symbolSize: number };
  ball: StylePreset & { symbolSize: number };
  person: StylePreset & { symbolSize: number };
  segment: StylePreset & {
    mode: MeasureMode;
    tickIntervalExpr: string;
    labelIntervalExpr: string;
    maxValueExpr: string;
    divisionPercents: number[];
    showMaxValue: boolean;
  };
}

type ResizeHandle = 'nw' | 'ne' | 'se' | 'sw' | 'start' | 'end';

type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'distributeX' | 'distributeY';
type ArrangeMode = 'front' | 'forward' | 'backward' | 'back';
type SnapKind = 'grid' | 'point' | 'center' | 'intersection' | 'edge';

interface SnapResult {
  point: Point;
  kind?: SnapKind;
}

type Interaction =
  | { kind: 'draw'; objectId: string; start: Point; tool: ToolId }
  | { kind: 'move'; objectIds: string[]; start: Point; originals: GraphicObject[] }
  | { kind: 'resize'; objectId: string; handle: ResizeHandle; original: GraphicObject; originalBounds: { x: number; y: number; width: number; height: number }; originalCenter: Point; rotation: number }
  | { kind: 'vertex'; objectId: string; index: number; original: GraphicObject; originalCenter: Point; rotation: number }
  | { kind: 'marquee'; start: Point; additive: boolean }
  | { kind: 'pan'; clientStart: Point; originalView: ViewState }
  | { kind: 'contextPan'; clientStart: Point; originalView: ViewState; moved: boolean }
  | { kind: 'rotate'; objectId: string; original: GraphicObject; center: Point; startAngle: number; originalRotation: number }
  | { kind: 'zoom'; start: Point }
  | null;

type ModalState =
  | { kind: 'settings' }
  | { kind: 'text'; point: Point; value: string }
  | { kind: 'math'; point: Point; value: string; expressionId?: string }
  | { kind: 'about' }
  | null;


const TOOL_CONTEXT_GROUPS: ToolId[][] = [
  ['select', 'pan', 'zoom'],
  ['line', 'arrow', 'pen'],
  ['rectangle', 'ellipse', 'polygon'],
  ['text', 'math'],
  ['array', 'ball', 'person'],
];

function groupForTool(tool: ToolId): ToolId[] | null {
  return TOOL_CONTEXT_GROUPS.find((group) => group.includes(tool)) ?? null;
}

interface ContextToolMenuState {
  clientX: number;
  clientY: number;
  tools: ToolId[];
}

interface TouchGestureState {
  pointerIds: [number, number];
  startPoints: [Point, Point];
  latestPoints: [Point, Point];
  originalView: ViewState;
  mode: 'pending' | 'pan' | 'pinch';
}

const MIN_DRAW_SIZE = 4;
const TWO_PI = Math.PI * 2;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

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

function normalizeDegrees(value: number): number {
  let angle = value;
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;
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
    line: { ...lineStyle, start: { x: '-4', y: '0' }, end: { x: '4', y: '0' } },
    arrow: { ...lineStyle, start: { x: '-4', y: '0' }, end: { x: '4', y: '0' }, arrowSize: 14 },
    rectangle: { ...shapeStyle, radius: 0 },
    ellipse: { ...shapeStyle, center: { x: '0', y: '0' }, majorRadiusExpr: '2', minorRadiusExpr: '2', eccentricityExpr: '0', majorAxis: 'x' },
    polygon: { ...shapeStyle },
    text: { ...lineStyle, fontSize: 28 },
    math: { ...lineStyle, fontSize: 30 },
    array: { ...lineStyle, rowsExpr: '3', colsExpr: '4', symbol: 'circle', symbolSize: 9 },
    ball: { ...lineStyle, symbolSize: 20 },
    person: { ...lineStyle, symbolSize: 24 },
    segment: {
      ...lineStyle,
      mode: 'numberLine',
      tickIntervalExpr: '1',
      labelIntervalExpr: '1',
      maxValueExpr: '10',
      divisionPercents: [50],
      showMaxValue: true,
    },
  };
}

function normalizeSettings(value: GraphantaSettings | null): GraphantaSettings {
  const base = createDefaultSettings();
  if (!value) return base;
  const visibleTools = [...new Set(value.visibleTools.filter((tool) => ALL_TOOLS.includes(tool)))];
  if (visibleTools.includes('pan') && !visibleTools.includes('zoom')) visibleTools.splice(visibleTools.indexOf('pan') + 1, 0, 'zoom');
  if (visibleTools.includes('array')) {
    const arrayIndex = visibleTools.indexOf('array');
    if (!visibleTools.includes('ball')) visibleTools.splice(arrayIndex + 1, 0, 'ball');
    if (!visibleTools.includes('person')) visibleTools.splice(visibleTools.indexOf('ball') + 1, 0, 'person');
  }
  return { ...base, ...value, visibleTools };
}

function normalizeObject(object: GraphicObject): GraphicObject {
  if (object.type === 'arrow') return { ...object, arrowSize: object.arrowSize ?? 14, bindings: object.bindings ?? {} };
  if (object.type === 'rectangle' || object.type === 'array' || object.type === 'pen' || object.type === 'polygon') {
    return { ...object, rotation: object.rotation ?? 0, bindings: object.bindings ?? {} };
  }
  if (object.type === 'ellipse') {
    return { ...object, rotation: object.rotation ?? 0, majorAxis: object.majorAxis ?? (object.rx >= object.ry ? 'x' : 'y'), bindings: object.bindings ?? {} };
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
      showMaxValue: object.showMaxValue !== false,
      rotation: object.rotation ?? 0,
      bindings: object.bindings ?? {},
    };
  }
  return { ...object, bindings: object.bindings ?? {} };
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

function objectRotation(object: GraphicObject): number {
  return 'rotation' in object && typeof object.rotation === 'number' ? object.rotation : 0;
}

function getObjectCenter(object: GraphicObject): Point {
  if ((object.type === 'pen' || object.type === 'polygon') && object.rotationCenter) return object.rotationCenter;
  const bounds = getObjectBounds(object);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function getDisplayCorners(object: GraphicObject): Point[] {
  const bounds = getObjectBounds(object);
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
  const rotation = objectRotation(object);
  if (!rotation) return corners;
  const center = getObjectCenter(object);
  return corners.map((point) => rotatePoint(point, center, rotation));
}

function getDisplayBounds(object: GraphicObject): { x: number; y: number; width: number; height: number } {
  if (object.type === 'line' || object.type === 'arrow' || object.type === 'segment') return normalizeRect(object.start, object.end);
  const corners = getDisplayCorners(object);
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function unionBounds(objects: GraphicObject[]): { x: number; y: number; width: number; height: number } | null {
  if (!objects.length) return null;
  const bounds = objects.map(getDisplayBounds);
  const x = Math.min(...bounds.map((item) => item.x));
  const y = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x, y, width: right - x, height: bottom - y };
}

function rectContainsBounds(container: { x: number; y: number; width: number; height: number }, child: { x: number; y: number; width: number; height: number }): boolean {
  return child.x >= container.x && child.y >= container.y && child.x + child.width <= container.x + container.width && child.y + child.height <= container.y + container.height;
}

function lineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const denominator = dax * dby - day * dbx;
  if (Math.abs(denominator) < 1e-8) return null;
  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const ta = (dx * dby - dy * dbx) / denominator;
  const tb = (dx * day - dy * dax) / denominator;
  if (ta < -1e-8 || ta > 1 + 1e-8 || tb < -1e-8 || tb > 1 + 1e-8) return null;
  return { x: a1.x + ta * dax, y: a1.y + ta * day };
}

function projectToSegment(point: Point, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-8) return start;
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return { x: start.x + dx * t, y: start.y + dy * t };
}

function displayedPoint(object: GraphicObject, point: Point): Point {
  const rotation = objectRotation(object);
  return rotation ? rotatePoint(point, getObjectCenter(object), rotation) : point;
}

function getSnapGeometry(object: GraphicObject): { points: Array<{ point: Point; kind: 'point' | 'center' }>; segments: Array<{ start: Point; end: Point }> } {
  const points: Array<{ point: Point; kind: 'point' | 'center' }> = [];
  const segments: Array<{ start: Point; end: Point }> = [];
  if (object.type === 'line' || object.type === 'arrow' || object.type === 'segment') {
    points.push({ point: object.start, kind: 'point' }, { point: object.end, kind: 'point' }, { point: { x: (object.start.x + object.end.x) / 2, y: (object.start.y + object.end.y) / 2 }, kind: 'center' });
    segments.push({ start: object.start, end: object.end });
    return { points, segments };
  }
  if (object.type === 'rectangle' || object.type === 'array') {
    const corners = getDisplayCorners(object);
    corners.forEach((point) => points.push({ point, kind: 'point' }));
    points.push({ point: getObjectCenter(object), kind: 'center' });
    corners.forEach((point, index) => segments.push({ start: point, end: corners[(index + 1) % corners.length] }));
    return { points, segments };
  }
  if (object.type === 'ellipse') {
    const center = getObjectCenter(object);
    points.push({ point: center, kind: 'center' });
    const cardinal = [
      { x: object.cx + object.rx, y: object.cy },
      { x: object.cx - object.rx, y: object.cy },
      { x: object.cx, y: object.cy + object.ry },
      { x: object.cx, y: object.cy - object.ry },
    ];
    cardinal.map((point) => displayedPoint(object, point)).forEach((point) => points.push({ point, kind: 'point' }));
    return { points, segments };
  }
  if (object.type === 'polygon' || object.type === 'pen') {
    const displayed = object.points.map((point) => displayedPoint(object, point));
    if (displayed.length) {
      points.push({ point: displayed[0], kind: 'point' });
      if (displayed.length > 1) points.push({ point: displayed.at(-1)!, kind: 'point' });
      if (object.type === 'polygon') displayed.forEach((point) => points.push({ point, kind: 'point' }));
      displayed.slice(0, -1).forEach((point, index) => segments.push({ start: point, end: displayed[index + 1] }));
      if (object.type === 'polygon' && displayed.length > 2) segments.push({ start: displayed.at(-1)!, end: displayed[0] });
      points.push({ point: getObjectCenter(object), kind: 'center' });
    }
    return { points, segments };
  }
  if (object.type === 'text' || object.type === 'math') {
    points.push({ point: { x: object.x, y: object.y }, kind: 'point' });
  }
  return { points, segments };
}

function toolForObject(object: GraphicObject): ToolId {
  if (object.type === 'line') return 'line';
  if (object.type === 'arrow') return 'arrow';
  if (object.type === 'segment') return 'segment';
  if (object.type === 'array' && object.symbol === 'ball') return 'ball';
  if (object.type === 'array' && object.symbol === 'person') return 'person';
  return object.type;
}


function bindingExpression(object: GraphicObject, key: string, fallback: number): string {
  const value = object.bindings?.[key];
  return value !== undefined && value !== '' ? value : String(roundValue(fallback));
}

function geometryBindingNumber(object: GraphicObject, key: string, fallback: number, variables: VariableDef[]): number {
  const expression = object.bindings?.[key];
  return expression !== undefined && expression !== '' ? resolveNumber(expression, variables, fallback) : fallback;
}

function clearGeometryBindings<T extends GraphicObject>(object: T): T {
  return { ...object, bindings: {} } as T;
}

function coordinateAngleDegrees(start: Point, end: Point): number {
  return normalizeDegrees(Math.atan2(-(end.y - start.y), end.x - start.x) * RAD_TO_DEG);
}

function cumulativeDivisionPositions(values: number[]): number[] {
  let total = 0;
  return values.map((value) => {
    total = Math.min(100, total + clamp(value, 0, 100));
    return total;
  }).filter((value) => value > 0 && value < 100);
}

function resolveGeometryObject(
  object: GraphicObject,
  variables: VariableDef[],
  worldToCoordinate: (point: Point) => Point,
  coordinateToWorld: (point: Point) => Point,
  coordinateUnitPx: number,
): GraphicObject {
  const rotationDegrees = (fallbackScreenRadians: number) => geometryBindingNumber(
    object,
    'rotationDeg',
    normalizeDegrees(-fallbackScreenRadians * RAD_TO_DEG),
    variables,
  );

  if (object.type === 'line' || object.type === 'arrow' || object.type === 'segment') {
    const startFallback = worldToCoordinate(object.start);
    const endFallback = worldToCoordinate(object.end);
    let startCoordinate = {
      x: geometryBindingNumber(object, 'startX', startFallback.x, variables),
      y: geometryBindingNumber(object, 'startY', startFallback.y, variables),
    };
    let endCoordinate = {
      x: geometryBindingNumber(object, 'endX', endFallback.x, variables),
      y: geometryBindingNumber(object, 'endY', endFallback.y, variables),
    };
    if (object.bindings?.rotationDeg !== undefined) {
      const center = { x: (startCoordinate.x + endCoordinate.x) / 2, y: (startCoordinate.y + endCoordinate.y) / 2 };
      const length = Math.hypot(endCoordinate.x - startCoordinate.x, endCoordinate.y - startCoordinate.y);
      const angle = geometryBindingNumber(object, 'rotationDeg', coordinateAngleDegrees(object.start, object.end), variables) * DEG_TO_RAD;
      const vector = { x: Math.cos(angle) * length / 2, y: Math.sin(angle) * length / 2 };
      startCoordinate = { x: center.x - vector.x, y: center.y - vector.y };
      endCoordinate = { x: center.x + vector.x, y: center.y + vector.y };
    }
    return { ...object, start: coordinateToWorld(startCoordinate), end: coordinateToWorld(endCoordinate) };
  }

  if (object.type === 'rectangle' || object.type === 'array') {
    const topLeft = worldToCoordinate({ x: object.x, y: object.y });
    const coordinateX = geometryBindingNumber(object, 'x', topLeft.x, variables);
    const coordinateY = geometryBindingNumber(object, 'y', topLeft.y, variables);
    const width = Math.max(0.001, Math.abs(geometryBindingNumber(object, 'width', object.width / coordinateUnitPx, variables))) * coordinateUnitPx;
    const height = Math.max(0.001, Math.abs(geometryBindingNumber(object, 'height', object.height / coordinateUnitPx, variables))) * coordinateUnitPx;
    const world = coordinateToWorld({ x: coordinateX, y: coordinateY });
    return { ...object, x: world.x, y: world.y, width, height, rotation: -rotationDegrees(object.rotation ?? 0) * DEG_TO_RAD };
  }

  if (object.type === 'ellipse') {
    const centerFallback = worldToCoordinate({ x: object.cx, y: object.cy });
    const center = coordinateToWorld({
      x: geometryBindingNumber(object, 'centerX', centerFallback.x, variables),
      y: geometryBindingNumber(object, 'centerY', centerFallback.y, variables),
    });
    const axis = object.majorAxis ?? (object.rx >= object.ry ? 'x' : 'y');
    const majorFallback = (axis === 'x' ? object.rx : object.ry) / coordinateUnitPx;
    const minorFallback = (axis === 'x' ? object.ry : object.rx) / coordinateUnitPx;
    const major = Math.max(0.001, Math.abs(geometryBindingNumber(object, 'majorRadius', majorFallback, variables)));
    let minor = Math.max(0.001, Math.abs(geometryBindingNumber(object, 'minorRadius', minorFallback, variables)));
    if (object.bindings?.eccentricity !== undefined) {
      const eccentricity = clamp(Math.abs(geometryBindingNumber(object, 'eccentricity', 0, variables)), 0, 0.999999);
      minor = major * Math.sqrt(1 - eccentricity * eccentricity);
    }
    return {
      ...object,
      cx: center.x,
      cy: center.y,
      rx: (axis === 'x' ? major : minor) * coordinateUnitPx,
      ry: (axis === 'y' ? major : minor) * coordinateUnitPx,
      majorAxis: axis,
      rotation: -rotationDegrees(object.rotation ?? 0) * DEG_TO_RAD,
    };
  }

  if (object.type === 'pen' || object.type === 'polygon') {
    return { ...object, rotation: -rotationDegrees(object.rotation ?? 0) * DEG_TO_RAD };
  }

  if (object.type === 'text' || object.type === 'math') {
    const fallback = worldToCoordinate({ x: object.x, y: object.y });
    const world = coordinateToWorld({
      x: geometryBindingNumber(object, 'x', fallback.x, variables),
      y: geometryBindingNumber(object, 'y', fallback.y, variables),
    });
    return { ...object, x: world.x, y: world.y };
  }

  return object;
}

function resizeGraphicObject(
  object: GraphicObject,
  handle: ResizeHandle,
  point: Point,
  bounds: { x: number; y: number; width: number; height: number },
  originalCenter: Point,
  rotation: number,
  forcePreserveRatio = false,
  releasePreserveRatio = false,
): GraphicObject {
  if (object.type === 'line' || object.type === 'arrow' || object.type === 'segment') {
    if (handle === 'start') return clearGeometryBindings({ ...object, start: point });
    if (handle === 'end') return clearGeometryBindings({ ...object, end: point });
    return object;
  }

  const opposite: Record<'nw' | 'ne' | 'se' | 'sw', Point> = {
    nw: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    ne: { x: bounds.x, y: bounds.y + bounds.height },
    se: { x: bounds.x, y: bounds.y },
    sw: { x: bounds.x + bounds.width, y: bounds.y },
  };
  if (!(handle in opposite)) return object;
  const anchorLocal = opposite[handle as keyof typeof opposite];
  const anchorWorld = rotatePoint(anchorLocal, originalCenter, rotation);
  const localPointer = rotatePoint(point, anchorWorld, -rotation);
  let dx = localPointer.x - anchorWorld.x;
  let dy = localPointer.y - anchorWorld.y;
  const naturalPreserve = object.type === 'pen' || object.type === 'polygon' || object.type === 'text' || object.type === 'math';
  const preserveRatio = forcePreserveRatio || (naturalPreserve && !releasePreserveRatio);
  if (preserveRatio) {
    const originalWidth = Math.max(1, bounds.width);
    const originalHeight = Math.max(1, bounds.height);
    const scale = Math.max(Math.abs(dx) / originalWidth, Math.abs(dy) / originalHeight, 0.01);
    dx = Math.sign(dx || (handle === 'nw' || handle === 'sw' ? -1 : 1)) * originalWidth * scale;
    dy = Math.sign(dy || (handle === 'nw' || handle === 'ne' ? -1 : 1)) * originalHeight * scale;
  }
  if (Math.abs(dx) < 4) dx = Math.sign(dx || 1) * 4;
  if (Math.abs(dy) < 4) dy = Math.sign(dy || 1) * 4;

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const halfVector = { x: dx / 2, y: dy / 2 };
  const centerWorld = {
    x: anchorWorld.x + halfVector.x * cos - halfVector.y * sin,
    y: anchorWorld.y + halfVector.x * sin + halfVector.y * cos,
  };
  const width = Math.abs(dx);
  const height = Math.abs(dy);
  const next = { x: centerWorld.x - width / 2, y: centerWorld.y - height / 2, width, height };
  const sx = width / Math.max(1, bounds.width);
  const sy = height / Math.max(1, bounds.height);
  const oldCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const mapPoint = (source: Point): Point => ({
    x: centerWorld.x + (source.x - oldCenter.x) * sx,
    y: centerWorld.y + (source.y - oldCenter.y) * sy,
  });

  if (object.type === 'rectangle' || object.type === 'array') {
    return clearGeometryBindings({ ...object, x: next.x, y: next.y, width, height });
  }
  if (object.type === 'ellipse') {
    const rx = width / 2;
    const ry = height / 2;
    return clearGeometryBindings({ ...object, cx: centerWorld.x, cy: centerWorld.y, rx, ry, majorAxis: rx >= ry ? 'x' : 'y' });
  }
  if (object.type === 'pen' || object.type === 'polygon') {
    return clearGeometryBindings({ ...object, rotationCenter: centerWorld, points: object.points.map(mapPoint) });
  }
  if (object.type === 'text' || object.type === 'math') {
    const mapped = mapPoint({ x: object.x, y: object.y });
    const scale = Math.max(sx, sy);
    return clearGeometryBindings({ ...object, x: mapped.x, y: mapped.y, fontSize: clamp(object.fontSize * scale, 6, 320) });
  }
  return object;
}

function App() {
  const initialSettings = useMemo(() => normalizeSettings(loadSettingsLocal()), []);
  const [project, setProject] = useState<GraphantaProject>(() => createInitialProject());
  const [settings, setSettings] = useState<GraphantaSettings>(initialSettings);
  const [presets, setPresets] = useState<ToolPresets>(() => createPresets(initialSettings));
  const [activeTool, setActiveTool] = useState<ToolId>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, zoom: 1 });
  const [interaction, setInteraction] = useState<Interaction>(null);
  const [zoomBox, setZoomBox] = useState<{ start: Point; end: Point } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ start: Point; end: Point } | null>(null);
  const [snapIndicator, setSnapIndicator] = useState<SnapResult | null>(null);
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
  const gestureSnapshot = useRef<GraphantaProject | null>(null);
  const gestureChanged = useRef(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: project.canvas.width, height: project.canvas.height });
  const [contextToolMenu, setContextToolMenu] = useState<ContextToolMenuState | null>(null);
  const [screenshotMenuOpen, setScreenshotMenuOpen] = useState(false);
  const [fourShotCaptures, setFourShotCaptures] = useState<PngCapture[]>([]);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const plotViewportRef = useRef<HTMLDivElement | null>(null);
  const activePointers = useRef(new Map<number, Point>());
  const touchGesture = useRef<TouchGestureState | null>(null);
  const centeredInitialView = useRef(false);

  const selectedId = selectedIds.at(-1) ?? null;
  const setSelectedId = useCallback((value: string | null) => setSelectedIds(value ? [value] : []), []);
  const selectedObjects = useMemo(() => project.objects.filter((object) => selectedIds.includes(object.id)), [project.objects, selectedIds]);
  const selectedObject = useMemo(() => project.objects.find((object) => object.id === selectedId) ?? null, [project.objects, selectedId]);
  const visibleTools = useMemo(() => settings.visibleTools.filter((tool) => ALL_TOOLS.includes(tool)), [settings.visibleTools]);
  const coordinateUnitPx = Math.min(project.canvas.width, project.canvas.height) / (2 * Math.max(1, project.canvas.coordinatePrecision));
  const coordinateOrigin = useMemo<Point>(() => ({ x: project.canvas.width / 2, y: project.canvas.height / 2 }), [project.canvas.width, project.canvas.height]);
  const visibleWorldWidth = viewportSize.width / view.zoom;
  const visibleWorldHeight = viewportSize.height / view.zoom;

  const worldToCoordinate = useCallback((point: Point): Point => ({
    x: roundValue((point.x - coordinateOrigin.x) / coordinateUnitPx),
    y: roundValue((coordinateOrigin.y - point.y) / coordinateUnitPx),
  }), [coordinateOrigin, coordinateUnitPx]);

  const coordinateToWorld = useCallback((point: Point): Point => ({
    x: coordinateOrigin.x + point.x * coordinateUnitPx,
    y: coordinateOrigin.y - point.y * coordinateUnitPx,
  }), [coordinateOrigin, coordinateUnitPx]);

  const resolveObject = useCallback((object: GraphicObject): GraphicObject => resolveGeometryObject(object, project.variables, worldToCoordinate, coordinateToWorld, coordinateUnitPx), [project.variables, worldToCoordinate, coordinateToWorld, coordinateUnitPx]);
  const resolvedObjects = useMemo(() => project.objects.filter((object) => !object.hidden).map(resolveObject), [project.objects, resolveObject]);
  const selectedResolvedObject = useMemo(() => selectedObject ? resolveObject(selectedObject) : null, [selectedObject, resolveObject]);
  const selectedResolvedObjects = useMemo(() => selectedObjects.map(resolveObject), [selectedObjects, resolveObject]);
  const snapGeometry = useMemo(() => {
    const entries = resolvedObjects.map((object) => ({ objectId: object.id, ...getSnapGeometry(object) }));
    const intersections: Array<{ point: Point; objectIds: [string, string] }> = [];
    for (let first = 0; first < entries.length; first += 1) {
      for (let second = first + 1; second < entries.length; second += 1) {
        for (const a of entries[first].segments) {
          for (const b of entries[second].segments) {
            const point = lineIntersection(a.start, a.end, b.start, b.end);
            if (point) intersections.push({ point, objectIds: [entries[first].objectId, entries[second].objectId] });
          }
        }
      }
    }
    return { entries, intersections };
  }, [resolvedObjects]);

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
    if (!selectedIds.length) return;
    const targets = new Set(selectedIds);
    mutateProject((current) => ({ ...current, objects: current.objects.filter((object) => !targets.has(object.id)) }));
    setSelectedIds([]);
    setStatus(`${selectedIds.length}要素を削除しました`);
  }, [mutateProject, selectedIds]);

  const duplicateSelected = useCallback(() => {
    if (!selectedObjects.length) return;
    const duplicates = selectedObjects.map((object) => translateObject({ ...structuredClone(object), id: createId(object.type) }, 20, 20));
    mutateProject((current) => ({ ...current, objects: [...current.objects, ...duplicates] }));
    setSelectedIds(duplicates.map((object) => object.id));
    setStatus(`${duplicates.length}要素を複製しました`);
  }, [mutateProject, selectedObjects]);

  const alignSelected = useCallback((mode: AlignMode) => {
    const movable = selectedResolvedObjects.filter((object) => !object.locked);
    if (movable.length < 2) return;
    const group = unionBounds(movable);
    if (!group) return;
    const translated = new Map<string, GraphicObject>();
    if (mode === 'distributeX' || mode === 'distributeY') {
      if (movable.length < 3) return;
      const horizontal = mode === 'distributeX';
      const sorted = [...movable].sort((a, b) => {
        const aBounds = getDisplayBounds(a);
        const bBounds = getDisplayBounds(b);
        const aCenter = horizontal ? aBounds.x + aBounds.width / 2 : aBounds.y + aBounds.height / 2;
        const bCenter = horizontal ? bBounds.x + bBounds.width / 2 : bBounds.y + bBounds.height / 2;
        return aCenter - bCenter;
      });
      const firstBounds = getDisplayBounds(sorted[0]);
      const lastBounds = getDisplayBounds(sorted.at(-1)!);
      const firstCenter = horizontal ? firstBounds.x + firstBounds.width / 2 : firstBounds.y + firstBounds.height / 2;
      const lastCenter = horizontal ? lastBounds.x + lastBounds.width / 2 : lastBounds.y + lastBounds.height / 2;
      const step = (lastCenter - firstCenter) / (sorted.length - 1);
      sorted.forEach((object, index) => {
        const bounds = getDisplayBounds(object);
        const center = horizontal ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2;
        const delta = firstCenter + step * index - center;
        translated.set(object.id, clearGeometryBindings(translateObject(object, horizontal ? delta : 0, horizontal ? 0 : delta)));
      });
    } else {
      movable.forEach((object) => {
        const bounds = getDisplayBounds(object);
        let dx = 0;
        let dy = 0;
        if (mode === 'left') dx = group.x - bounds.x;
        if (mode === 'center') dx = group.x + group.width / 2 - (bounds.x + bounds.width / 2);
        if (mode === 'right') dx = group.x + group.width - (bounds.x + bounds.width);
        if (mode === 'top') dy = group.y - bounds.y;
        if (mode === 'middle') dy = group.y + group.height / 2 - (bounds.y + bounds.height / 2);
        if (mode === 'bottom') dy = group.y + group.height - (bounds.y + bounds.height);
        translated.set(object.id, clearGeometryBindings(translateObject(object, dx, dy)));
      });
    }
    mutateProject((current) => ({ ...current, objects: current.objects.map((object) => translated.get(object.id) ?? object) }));
    setStatus('選択要素を整列しました');
  }, [mutateProject, selectedResolvedObjects]);

  const arrangeSelected = useCallback((mode: ArrangeMode) => {
    if (!selectedIds.length) return;
    const selected = new Set(selectedIds);
    mutateProject((current) => {
      const objects = [...current.objects];
      if (mode === 'front') return { ...current, objects: [...objects.filter((object) => !selected.has(object.id)), ...objects.filter((object) => selected.has(object.id))] };
      if (mode === 'back') return { ...current, objects: [...objects.filter((object) => selected.has(object.id)), ...objects.filter((object) => !selected.has(object.id))] };
      if (mode === 'forward') {
        for (let index = objects.length - 2; index >= 0; index -= 1) {
          if (selected.has(objects[index].id) && !selected.has(objects[index + 1].id)) [objects[index], objects[index + 1]] = [objects[index + 1], objects[index]];
        }
      } else {
        for (let index = 1; index < objects.length; index += 1) {
          if (selected.has(objects[index].id) && !selected.has(objects[index - 1].id)) [objects[index], objects[index - 1]] = [objects[index - 1], objects[index]];
        }
      }
      return { ...current, objects };
    });
    setStatus('重なり順を変更しました');
  }, [mutateProject, selectedIds]);

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
    const element = plotViewportRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      setViewportSize({ width, height });
      if (!centeredInitialView.current) {
        centeredInitialView.current = true;
        setView((current) => ({ ...current, x: coordinateOrigin.x - width / (2 * current.zoom), y: coordinateOrigin.y - height / (2 * current.zoom) }));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [coordinateOrigin]);

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
        if (gestureSnapshot.current) {
          setProject(gestureSnapshot.current);
          gestureSnapshot.current = null;
          gestureChanged.current = false;
        }
        setPolygonPoints([]);
        setInteraction(null);
        setZoomBox(null);
        setSelectionBox(null);
        setSnapIndicator(null);
        setModal(null);
        setContextToolMenu(null);
        setScreenshotMenuOpen(false);
        setSelectedIds([]);
      } else if (event.key === 'Enter' && polygonPoints.length >= 3) {
        event.preventDefault();
        finalizePolygon();
      } else if (selectedResolvedObjects.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0;
        const dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
        const replacements = new Map(selectedResolvedObjects.map((object) => [object.id, clearGeometryBindings(translateObject(object, dx, dy))]));
        mutateProject((current) => ({ ...current, objects: current.objects.map((object) => replacements.get(object.id) ?? object) }));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelected, mutateProject, polygonPoints.length, redo, selectedResolvedObjects, undo]);

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

  const snapWorldPoint = useCallback((point: Point, excludeIds: string[] = []): SnapResult => {
    const excluded = new Set(excludeIds);
    let gridResult: SnapResult = { point };
    if (project.canvas.snapGrid && (project.canvas.gridVisible || project.canvas.axesVisible)) {
      const step = project.canvas.axesVisible
        ? coordinateUnitPx * Math.max(project.canvas.tickInterval || 1, 0.0001)
        : project.canvas.gridSize;
      gridResult = {
        point: {
          x: coordinateOrigin.x + Math.round((point.x - coordinateOrigin.x) / step) * step,
          y: coordinateOrigin.y + Math.round((point.y - coordinateOrigin.y) / step) * step,
        },
        kind: 'grid',
      };
    }
    if (!project.canvas.snapPoints) return gridResult;

    const threshold = 13 / Math.max(0.25, view.zoom);
    let best: SnapResult | null = null;
    let bestDistance = threshold;
    const consider = (candidate: Point, kind: SnapKind) => {
      const candidateDistance = distance(point, candidate);
      if (candidateDistance <= bestDistance) {
        bestDistance = candidateDistance;
        best = { point: candidate, kind };
      }
    };

    snapGeometry.intersections.forEach((candidate) => {
      if (candidate.objectIds.some((id) => excluded.has(id))) return;
      consider(candidate.point, 'intersection');
    });
    snapGeometry.entries.forEach((entry) => {
      if (excluded.has(entry.objectId)) return;
      entry.points.forEach((candidate) => consider(candidate.point, candidate.kind));
    });
    snapGeometry.entries.forEach((entry) => {
      if (excluded.has(entry.objectId)) return;
      entry.segments.forEach((segment) => consider(projectToSegment(point, segment.start, segment.end), 'edge'));
    });
    return best ?? gridResult;
  }, [coordinateOrigin, coordinateUnitPx, project.canvas.axesVisible, project.canvas.gridSize, project.canvas.gridVisible, project.canvas.snapGrid, project.canvas.snapPoints, project.canvas.tickInterval, snapGeometry, view.zoom]);

  const worldPoint = useCallback((clientX: number, clientY: number, excludeIds: string[] = []): Point => {
    const result = snapWorldPoint(rawWorldPoint(clientX, clientY), excludeIds);
    setSnapIndicator(result.kind ? result : null);
    return result.point;
  }, [rawWorldPoint, snapWorldPoint]);


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
      : tool === 'ball' ? presets.ball
      : tool === 'person' ? presets.person
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
        return { id: createId('ellipse'), type: 'ellipse', cx: point.x, cy: point.y, rx: 0, ry: 0, rotation: 0, majorAxis: 'x', ...style };
      case 'array':
        return {
          id: createId('array'), type: 'array', x: point.x, y: point.y, width: 0, height: 0,
          rowsExpr: presets.array.rowsExpr, colsExpr: presets.array.colsExpr, symbol: presets.array.symbol,
          symbolSize: presets.array.symbolSize, rotation: 0, ...style,
        };
      case 'ball':
      case 'person': {
        const size = presets[tool].symbolSize;
        return {
          id: createId(tool), type: 'array', x: point.x - size, y: point.y - size, width: size * 2, height: size * 2,
          rowsExpr: '1', colsExpr: '1', symbol: tool, symbolSize: size, rotation: 0, ...style,
        };
      }
      case 'segment':
        return {
          id: createId('segment'), type: 'segment', start: point, end: point,
          mode: presets.segment.mode, tickIntervalExpr: presets.segment.tickIntervalExpr,
          labelIntervalExpr: presets.segment.labelIntervalExpr, maxValueExpr: presets.segment.maxValueExpr,
          divisionPercents: [...presets.segment.divisionPercents], showMaxValue: presets.segment.showMaxValue, rotation: 0, ...style,
        };
      default:
        return null;
    }
  }, [presets, settings.defaultFill, settings.defaultStroke, settings.defaultStrokeWidth]);

  function chooseTool(tool: ToolId) {
    setActiveTool(tool);
    setSelectedIds([]);
    setPolygonPoints([]);
    setInteraction(null);
    setZoomBox(null);
    setSelectionBox(null);
    setSnapIndicator(null);
    setContextToolMenu(null);
    setStatus(`${TOOL_LABELS[tool]}を選択しました`);
  }

  function openToolContextAt(clientX: number, clientY: number) {
    const tools = groupForTool(activeTool);
    if (!tools) return;
    setContextToolMenu({ clientX, clientY, tools });
  }

  function cancelInteractionForTwoFingerGesture() {
    if (interaction?.kind === 'draw') {
      setProject((current) => ({ ...current, objects: current.objects.filter((item) => item.id !== interaction.objectId) }));
      undoStack.current.pop();
      setSelectedId(null);
    } else if (gestureSnapshot.current) {
      setProject(gestureSnapshot.current);
    }
    gestureSnapshot.current = null;
    gestureChanged.current = false;
    setInteraction(null);
    setZoomBox(null);
    setSelectionBox(null);
    setSnapIndicator(null);
    if (activeTool === 'polygon') setPolygonPoints((points) => points.slice(0, -1));
    if (modal?.kind === 'text' || modal?.kind === 'math') setModal(null);
  }

  function beginPointer(event: ReactPointerEvent<SVGSVGElement>) {
    setContextToolMenu(null);
    setScreenshotMenuOpen(false);
    if (event.pointerType === 'touch') {
      activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* noop */ }
      if (activePointers.current.size === 2) {
        const entries = [...activePointers.current.entries()] as Array<[number, Point]>;
        cancelInteractionForTwoFingerGesture();
        touchGesture.current = {
          pointerIds: [entries[0][0], entries[1][0]],
          startPoints: [entries[0][1], entries[1][1]],
          latestPoints: [entries[0][1], entries[1][1]],
          originalView: view,
          mode: 'pending',
        };
        event.preventDefault();
        return;
      }
      if (activePointers.current.size > 2) {
        event.preventDefault();
        return;
      }
    }
    if (event.button === 2) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({ kind: 'contextPan', clientStart: { x: event.clientX, y: event.clientY }, originalView: view, moved: false });
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.target as Element;
    const vertexAddElement = target.closest('[data-vertex-add-index]');
    const vertexAddIndexText = vertexAddElement?.getAttribute('data-vertex-add-index');
    const vertexAddObjectId = vertexAddElement?.getAttribute('data-vertex-object-id') ?? null;
    const vertexElement = target.closest('[data-vertex-index]');
    const vertexIndexText = vertexElement?.getAttribute('data-vertex-index');
    const vertexObjectId = vertexElement?.getAttribute('data-vertex-object-id') ?? null;
    const rotateElement = target.closest('[data-rotate-object-id]');
    const rotateObjectId = rotateElement?.getAttribute('data-rotate-object-id') ?? null;
    const resizeElement = target.closest('[data-resize-handle]');
    const resizeHandle = resizeElement?.getAttribute('data-resize-handle') as ResizeHandle | null;
    const resizeObjectId = resizeElement?.getAttribute('data-resize-object-id') ?? null;
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

    if (vertexAddObjectId && vertexAddIndexText !== null) {
      const source = project.objects.find((item) => item.id === vertexAddObjectId);
      if (!source || source.type !== 'polygon' || source.locked) return;
      const resolved = resolveObject(source) as PolygonObject;
      const index = Number(vertexAddIndexText);
      const displayed = resolved.points.map((point) => displayedPoint(resolved, point));
      const previous = displayed[(index - 1 + displayed.length) % displayed.length];
      const next = displayed[index % displayed.length];
      const midpoint = { x: (previous.x + next.x) / 2, y: (previous.y + next.y) / 2 };
      const local = rotatePoint(midpoint, getObjectCenter(resolved), -objectRotation(resolved));
      updateObject(source.id, () => clearGeometryBindings({ ...resolved, rotationCenter: getObjectCenter(resolved), points: [...resolved.points.slice(0, index), local, ...resolved.points.slice(index)] }));
      setSelectedId(source.id);
      setStatus('多角形に頂点を追加しました');
      return;
    }

    if (vertexObjectId && vertexIndexText !== null) {
      const source = project.objects.find((item) => item.id === vertexObjectId);
      if (!source || source.type !== 'polygon' || source.locked) return;
      const resolved = resolveObject(source) as PolygonObject;
      const index = Number(vertexIndexText);
      if (event.shiftKey && resolved.points.length > 3) {
        updateObject(source.id, () => clearGeometryBindings({ ...resolved, rotationCenter: getObjectCenter(resolved), points: resolved.points.filter((_, pointIndex) => pointIndex !== index) }));
        setSelectedId(source.id);
        setStatus('多角形の頂点を削除しました');
        return;
      }
      gestureSnapshot.current = structuredClone(project);
      gestureChanged.current = false;
      setSelectedId(vertexObjectId);
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({ kind: 'vertex', objectId: vertexObjectId, index, original: structuredClone(resolved), originalCenter: getObjectCenter(resolved), rotation: objectRotation(resolved) });
      return;
    }

    if (rotateObjectId) {
      const source = project.objects.find((item) => item.id === rotateObjectId);
      if (!source || source.locked || !('rotation' in source)) return;
      const resolved = resolveObject(source);
      const center = getObjectCenter(resolved);
      const point = rawWorldPoint(event.clientX, event.clientY);
      gestureSnapshot.current = structuredClone(project);
      gestureChanged.current = false;
      setSelectedId(rotateObjectId);
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({ kind: 'rotate', objectId: rotateObjectId, original: structuredClone(resolved), center, startAngle: angleOf(center, point), originalRotation: objectRotation(resolved) });
      return;
    }

    if (resizeHandle && resizeObjectId) {
      const source = project.objects.find((item) => item.id === resizeObjectId);
      if (!source || source.locked) return;
      const resolved = resolveObject(source);
      gestureSnapshot.current = structuredClone(project);
      gestureChanged.current = false;
      setSelectedId(resizeObjectId);
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({
        kind: 'resize',
        objectId: resizeObjectId,
        handle: resizeHandle,
        original: structuredClone(resolved),
        originalBounds: getObjectBounds(resolved),
        originalCenter: getObjectCenter(resolved),
        rotation: objectRotation(resolved),
      });
      return;
    }

    if (activeTool === 'select') {
      if (!objectId) {
        const start = rawWorldPoint(event.clientX, event.clientY);
        if (!event.shiftKey) setSelectedIds([]);
        event.currentTarget.setPointerCapture(event.pointerId);
        setInteraction({ kind: 'marquee', start, additive: event.shiftKey });
        setSelectionBox({ start, end: start });
        return;
      }
      const object = project.objects.find((item) => item.id === objectId);
      if (!object) return;
      if (event.shiftKey) {
        setSelectedIds((current) => current.includes(objectId) ? current.filter((id) => id !== objectId) : [...current, objectId]);
        return;
      }
      const nextIds = selectedIds.includes(objectId) ? selectedIds : [objectId];
      setSelectedIds(nextIds);
      if (object.locked) return;
      const originals = nextIds
        .map((id) => project.objects.find((item) => item.id === id))
        .filter((item): item is GraphicObject => item !== undefined && !item.locked)
        .map(resolveObject)
        .map((item) => structuredClone(item));
      if (!originals.length) return;
      const point = worldPoint(event.clientX, event.clientY, nextIds);
      gestureSnapshot.current = structuredClone(project);
      gestureChanged.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({ kind: 'move', objectIds: originals.map((item) => item.id), start: point, originals });
      return;
    }

    const point = worldPoint(event.clientX, event.clientY);
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
    setInteraction({ kind: 'draw', objectId: object.id, start: point, tool: activeTool });
  }

  function movePointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerType === 'touch' && activePointers.current.has(event.pointerId)) {
      activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const gesture = touchGesture.current;
      if (gesture) {
        const first = activePointers.current.get(gesture.pointerIds[0]);
        const second = activePointers.current.get(gesture.pointerIds[1]);
        if (first && second) {
          event.preventDefault();
          gesture.latestPoints = [first, second];
          const startCenter = { x: (gesture.startPoints[0].x + gesture.startPoints[1].x) / 2, y: (gesture.startPoints[0].y + gesture.startPoints[1].y) / 2 };
          const currentCenter = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
          const centerShift = distance(startCenter, currentCenter);
          const startDistance = Math.max(1, distance(gesture.startPoints[0], gesture.startPoints[1]));
          const currentDistance = Math.max(1, distance(first, second));
          const scaleChange = Math.abs(currentDistance / startDistance - 1);
          if (gesture.mode === 'pending') {
            if (scaleChange > 0.055) gesture.mode = 'pinch';
            else if (centerShift > 7) gesture.mode = 'pan';
          }
          if (gesture.mode === 'pan') {
            const dx = ((currentCenter.x - startCenter.x) / Math.max(1, viewportSize.width)) * (viewportSize.width / gesture.originalView.zoom);
            const dy = ((currentCenter.y - startCenter.y) / Math.max(1, viewportSize.height)) * (viewportSize.height / gesture.originalView.zoom);
            setView({ ...gesture.originalView, x: gesture.originalView.x - dx, y: gesture.originalView.y - dy });
          } else if (gesture.mode === 'pinch') {
            const nextZoom = clamp(gesture.originalView.zoom * (currentDistance / startDistance), 0.25, 8);
            const rect = event.currentTarget.getBoundingClientRect();
            const startRatioX = (startCenter.x - rect.left) / Math.max(1, rect.width);
            const startRatioY = (startCenter.y - rect.top) / Math.max(1, rect.height);
            const anchorWorld = {
              x: gesture.originalView.x + startRatioX * (viewportSize.width / gesture.originalView.zoom),
              y: gesture.originalView.y + startRatioY * (viewportSize.height / gesture.originalView.zoom),
            };
            const currentRatioX = (currentCenter.x - rect.left) / Math.max(1, rect.width);
            const currentRatioY = (currentCenter.y - rect.top) / Math.max(1, rect.height);
            setView({
              x: anchorWorld.x - currentRatioX * (viewportSize.width / nextZoom),
              y: anchorWorld.y - currentRatioY * (viewportSize.height / nextZoom),
              zoom: nextZoom,
            });
          }
          return;
        }
      }
    }
    if (!interaction) return;
    event.preventDefault();
    if (interaction.kind === 'pan' || interaction.kind === 'contextPan') {
      const rect = event.currentTarget.getBoundingClientRect();
      const worldWidth = viewportSize.width / interaction.originalView.zoom;
      const worldHeight = viewportSize.height / interaction.originalView.zoom;
      const dx = ((event.clientX - interaction.clientStart.x) / Math.max(1, rect.width)) * worldWidth;
      const dy = ((event.clientY - interaction.clientStart.y) / Math.max(1, rect.height)) * worldHeight;
      setView({ ...interaction.originalView, x: interaction.originalView.x - dx, y: interaction.originalView.y - dy });
      if (interaction.kind === 'contextPan' && !interaction.moved && Math.hypot(event.clientX - interaction.clientStart.x, event.clientY - interaction.clientStart.y) > 4) {
        setInteraction({ ...interaction, moved: true });
      }
      return;
    }
    if (interaction.kind === 'zoom') {
      setZoomBox({ start: interaction.start, end: rawWorldPoint(event.clientX, event.clientY) });
      return;
    }
    if (interaction.kind === 'marquee') {
      setSelectionBox({ start: interaction.start, end: rawWorldPoint(event.clientX, event.clientY) });
      return;
    }

    const excluded = interaction.kind === 'move' ? interaction.objectIds : [interaction.objectId];
    let point = worldPoint(event.clientX, event.clientY, excluded);
    if (interaction.kind === 'draw' && event.shiftKey) {
      const dx = point.x - interaction.start.x;
      const dy = point.y - interaction.start.y;
      const source = project.objects.find((item) => item.id === interaction.objectId);
      if (source?.type === 'line' || source?.type === 'arrow' || source?.type === 'segment') {
        const length = Math.hypot(dx, dy);
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        point = { x: interaction.start.x + Math.cos(angle) * length, y: interaction.start.y + Math.sin(angle) * length };
      } else if (source?.type === 'rectangle' || source?.type === 'ellipse' || source?.type === 'array') {
        const size = Math.max(Math.abs(dx), Math.abs(dy));
        point = { x: interaction.start.x + Math.sign(dx || 1) * size, y: interaction.start.y + Math.sign(dy || 1) * size };
      }
    }
    if (interaction.kind === 'move') {
      gestureChanged.current = true;
      const dx = point.x - interaction.start.x;
      const dy = point.y - interaction.start.y;
      const replacements = new Map(interaction.originals.map((object) => [object.id, clearGeometryBindings(translateObject(object, dx, dy))]));
      mutateProject((current) => ({ ...current, objects: current.objects.map((object) => replacements.get(object.id) ?? object) }), false);
      return;
    }
    if (interaction.kind === 'vertex') {
      if (interaction.original.type !== 'polygon') return;
      gestureChanged.current = true;
      const localPoint = rotatePoint(point, interaction.originalCenter, -interaction.rotation);
      const points = interaction.original.points.map((source, index) => index === interaction.index ? localPoint : source);
      updateObject(interaction.objectId, () => clearGeometryBindings({ ...interaction.original, rotationCenter: interaction.originalCenter, points }), false);
      return;
    }
    if (interaction.kind === 'rotate') {
      gestureChanged.current = true;
      const currentAngle = angleOf(interaction.center, point);
      let rotation = interaction.originalRotation + normalizeAngle(currentAngle - interaction.startAngle);
      if (event.shiftKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      updateObject(interaction.objectId, (current) => ('rotation' in current ? clearGeometryBindings({ ...current, rotation } as GraphicObject) : current), false);
      return;
    }
    if (interaction.kind === 'resize') {
      gestureChanged.current = true;
      updateObject(interaction.objectId, () => resizeGraphicObject(
        interaction.original,
        interaction.handle,
        point,
        interaction.originalBounds,
        interaction.originalCenter,
        interaction.rotation,
        event.shiftKey,
        event.altKey,
      ), false);
      return;
    }

    updateObject(interaction.objectId, (object) => {
      switch (object.type) {
        case 'pen': {
          const last = object.points.at(-1);
          if (last && distance(last, point) < 1.2 / Math.max(view.zoom, 0.25)) return object;
          return { ...object, points: [...object.points, point] };
        }
        case 'line':
        case 'arrow':
        case 'segment':
          return { ...object, end: point };
        case 'rectangle': {
          const rect = normalizeRect(interaction.start, point);
          return { ...object, ...rect };
        }
        case 'ellipse':
          return { ...object, cx: interaction.start.x, cy: interaction.start.y, rx: Math.abs(point.x - interaction.start.x), ry: Math.abs(point.y - interaction.start.y), majorAxis: Math.abs(point.x - interaction.start.x) >= Math.abs(point.y - interaction.start.y) ? 'x' : 'y' };
        case 'array': {
          if ((object.symbol === 'ball' || object.symbol === 'person') && interaction.tool !== 'array') {
            const dx = point.x - interaction.start.x;
            const dy = point.y - interaction.start.y;
            if (Math.hypot(dx, dy) < 4 / Math.max(view.zoom, 0.25)) return object;
            const rect = normalizeRect(interaction.start, point);
            const size = Math.max(3, Math.min(rect.width, rect.height) / 2);
            return { ...object, ...rect, symbolSize: size };
          }
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
    const visibleWidth = viewportSize.width / nextZoom;
    const visibleHeight = viewportSize.height / nextZoom;
    setView({ x: point.x - visibleWidth / 2, y: point.y - visibleHeight / 2, zoom: nextZoom });
  }

  function fitZoomRect(rect: { x: number; y: number; width: number; height: number }) {
    const aspect = viewportSize.width / Math.max(1, viewportSize.height);
    const paddedWidth = Math.max(rect.width * 1.08, rect.height * aspect * 1.08, 10);
    const paddedHeight = paddedWidth / aspect;
    const nextZoom = clamp(viewportSize.width / paddedWidth, 0.25, 8);
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    setView({ x: center.x - paddedWidth / 2, y: center.y - paddedHeight / 2, zoom: nextZoom });
  }

  function endPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerType === 'touch') {
      const gesture = touchGesture.current;
      activePointers.current.delete(event.pointerId);
      if (gesture) {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (activePointers.current.size < 2) {
          const center = {
            x: (gesture.latestPoints[0].x + gesture.latestPoints[1].x) / 2,
            y: (gesture.latestPoints[0].y + gesture.latestPoints[1].y) / 2,
          };
          if (event.type !== 'pointercancel' && gesture.mode === 'pending') openToolContextAt(center.x, center.y);
          else if (gesture.mode === 'pan') setStatus('2本指で表示位置を移動しました');
          else setStatus('ピンチ操作で表示倍率を変更しました');
          touchGesture.current = null;
        }
        return;
      }
    }
    if (!interaction) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setSnapIndicator(null);
    if (interaction.kind === 'contextPan') {
      const moved = interaction.moved || Math.hypot(event.clientX - interaction.clientStart.x, event.clientY - interaction.clientStart.y) > 4;
      if (!moved) openToolContextAt(event.clientX, event.clientY);
      else setStatus('表示位置を移動しました');
      setInteraction(null);
      return;
    }
    if (event.type === 'pointercancel' && gestureSnapshot.current) {
      setProject(gestureSnapshot.current);
      gestureSnapshot.current = null;
      gestureChanged.current = false;
      setSelectionBox(null);
      setZoomBox(null);
      setInteraction(null);
      setStatus('操作を取り消しました');
      return;
    }
    if (interaction.kind === 'zoom') {
      const end = rawWorldPoint(event.clientX, event.clientY);
      const rect = normalizeRect(interaction.start, end);
      if (rect.width < 8 / view.zoom && rect.height < 8 / view.zoom) zoomAt(end, event.shiftKey ? 1 / 1.5 : 1.5);
      else fitZoomRect(rect);
      setZoomBox(null);
      setInteraction(null);
      return;
    }
    if (interaction.kind === 'marquee') {
      const end = rawWorldPoint(event.clientX, event.clientY);
      const rect = normalizeRect(interaction.start, end);
      if (rect.width >= 3 / view.zoom || rect.height >= 3 / view.zoom) {
        const matches = resolvedObjects.filter((object) => rectContainsBounds(rect, getDisplayBounds(object))).map((object) => object.id);
        setSelectedIds((current) => interaction.additive ? [...new Set([...current, ...matches])] : matches);
        setStatus(matches.length ? `${matches.length}要素を範囲選択しました` : '選択を解除しました');
      }
      setSelectionBox(null);
      setInteraction(null);
      return;
    }
    if (interaction.kind === 'move' || interaction.kind === 'resize' || interaction.kind === 'vertex' || interaction.kind === 'rotate') {
      if (gestureChanged.current && gestureSnapshot.current) commitHistory(gestureSnapshot.current);
      gestureSnapshot.current = null;
      gestureChanged.current = false;
      setInteraction(null);
      return;
    }
    if (interaction.kind === 'draw') {
      const source = project.objects.find((item) => item.id === interaction.objectId);
      if (source) {
        const object = resolveObject(source);
        const bounds = getObjectBounds(object);
        const isSingleSymbol = object.type === 'array' && (object.symbol === 'ball' || object.symbol === 'person');
        if (isSingleSymbol) {
          const tool: 'ball' | 'person' = object.symbol === 'ball' ? 'ball' : 'person';
          const nextSize = Math.max(3, Math.min(object.width, object.height) / 2);
          setPresets((current) => ({ ...current, [tool]: { ...current[tool], symbolSize: nextSize } }));
        } else if (bounds.width < MIN_DRAW_SIZE && bounds.height < MIN_DRAW_SIZE && object.type !== 'pen') {
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
    const widthOld = viewportSize.width / oldZoom;
    const heightOld = viewportSize.height / oldZoom;
    const ratioX = (point.x - view.x) / widthOld;
    const ratioY = (point.y - view.y) / heightOld;
    const widthNew = viewportSize.width / nextZoom;
    const heightNew = viewportSize.height / nextZoom;
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
      const startCoordinate = {
        x: resolveNumber(preset.start.x, project.variables, -4),
        y: resolveNumber(preset.start.y, project.variables, 0),
      };
      const endCoordinate = {
        x: resolveNumber(preset.end.x, project.variables, 4),
        y: resolveNumber(preset.end.y, project.variables, 0),
      };
      object = {
        id: createId(tool), type: tool,
        stroke: preset.stroke, fill: preset.fill, strokeWidth: preset.strokeWidth, opacity: preset.opacity,
        start: coordinateToWorld(startCoordinate), end: coordinateToWorld(endCoordinate),
        bindings: { startX: preset.start.x, startY: preset.start.y, endX: preset.end.x, endY: preset.end.y },
        ...(tool === 'arrow' ? { arrowSize: presets.arrow.arrowSize } : {}),
      } as GraphicObject;
    } else {
      const preset = presets.ellipse;
      const centerCoordinate = {
        x: resolveNumber(preset.center.x, project.variables, 0),
        y: resolveNumber(preset.center.y, project.variables, 0),
      };
      const center = coordinateToWorld(centerCoordinate);
      const major = Math.max(0.05, Math.abs(resolveNumber(preset.majorRadiusExpr, project.variables, 2)));
      let minor = Math.max(0.05, Math.abs(resolveNumber(preset.minorRadiusExpr, project.variables, 2)));
      const eccentricity = clamp(Math.abs(resolveNumber(preset.eccentricityExpr, project.variables, 0)), 0, 0.999999);
      if (eccentricity > 0) minor = major * Math.sqrt(1 - eccentricity * eccentricity);
      const bindings: Record<string, string> = {
        centerX: preset.center.x,
        centerY: preset.center.y,
        majorRadius: preset.majorRadiusExpr,
        minorRadius: preset.minorRadiusExpr,
      };
      const eccentricitySource = preset.eccentricityExpr.trim();
      if (eccentricitySource && !/^[-+]?0+(?:\.0+)?$/.test(eccentricitySource)) {
        bindings.eccentricity = eccentricitySource;
      }
      object = {
        id: createId('ellipse'), type: 'ellipse', cx: center.x, cy: center.y,
        rx: (preset.majorAxis === 'x' ? major : minor) * coordinateUnitPx,
        ry: (preset.majorAxis === 'y' ? major : minor) * coordinateUnitPx,
        majorAxis: preset.majorAxis,
        bindings,
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
    const symbolRatio = object.symbol === 'ball' || object.symbol === 'person' ? 0.48 : 0.36;
    const symbolSize = Math.max(1, Math.min(object.symbolSize, Math.abs(cellWidth) * symbolRatio, Math.abs(cellHeight) * symbolRatio));
    const symbols = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cx = object.x + cellWidth * (col + 0.5);
        const cy = object.y + cellHeight * (row + 0.5);
        const fill = object.fill === 'transparent' ? object.stroke : object.fill;
        const key = `${row}-${col}`;
        if (object.symbol === 'circle') symbols.push(<circle key={key} cx={cx} cy={cy} r={symbolSize} fill={fill} stroke="none" />);
        else if (object.symbol === 'square') symbols.push(<rect key={key} x={cx - symbolSize} y={cy - symbolSize} width={symbolSize * 2} height={symbolSize * 2} fill={fill} stroke="none" />);
        else if (object.symbol === 'dot') symbols.push(<circle key={key} cx={cx} cy={cy} r={Math.max(2, symbolSize * 0.42)} fill={object.stroke} stroke="none" />);
        else if (object.symbol === 'ball') symbols.push(<g key={key}><circle cx={cx + symbolSize * 0.08} cy={cy + symbolSize * 0.12} r={symbolSize} fill="#18233b" opacity={0.18} /><circle cx={cx} cy={cy} r={symbolSize} fill={fill} stroke={object.stroke} strokeWidth={Math.max(0.8, object.strokeWidth * 0.55)} /><ellipse cx={cx - symbolSize * 0.3} cy={cy - symbolSize * 0.32} rx={symbolSize * 0.28} ry={symbolSize * 0.2} fill="#ffffff" opacity={0.42} /></g>);
        else if (object.symbol === 'person') {
          const scale = symbolSize / 12;
          symbols.push(<g key={key} transform={`translate(${cx} ${cy}) scale(${scale})`} fill={fill} stroke={object.stroke} strokeWidth={Math.max(0.7, object.strokeWidth / Math.max(scale, 0.01))} strokeLinecap="round" strokeLinejoin="round"><circle cx="0" cy="-7" r="3" /><path d="M-4 -2 C-4 -4 -2.2 -5 0 -5 C2.2 -5 4 -4 4 -2 L4 5 L2.2 5 L2.2 11 L-2.2 11 L-2.2 5 L-4 5 Z" /><path d="M-4 -1 L-8 5 M4 -1 L8 5" fill="none" /></g>);
        } else symbols.push(<path key={key} d={`M ${cx - symbolSize} ${cy - symbolSize} L ${cx + symbolSize} ${cy + symbolSize} M ${cx + symbolSize} ${cy - symbolSize} L ${cx - symbolSize} ${cy + symbolSize}`} fill="none" stroke={object.stroke} strokeWidth={object.strokeWidth} />);
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
    const points = cumulativeDivisionPositions(object.divisionPercents);
    const maxValue = resolveNumber(object.maxValueExpr, project.variables, 10);
    const markerPercents = [0, ...points, 100];
    const valueLabel = (percent: number, offset: number) => {
      if (percent === 100 && !object.showMaxValue) return null;
      const x = object.start.x + dx * percent / 100 + normal.x * offset;
      const y = object.start.y + dy * percent / 100 + normal.y * offset;
      const value = percent === 0 ? 0 : roundValue(maxValue * percent / 100);
      return <text key={`value-${percent}`} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={16} fill={object.stroke} stroke="none">{value}</text>;
    };
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
          {markerPercents.map((percent) => valueLabel(percent, height / 2 + 18))}
        </g>
      );
    }
    return (
      <g>
        <line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} />
        {markerPercents.map((percent) => {
          const x = object.start.x + dx * percent / 100;
          const y = object.start.y + dy * percent / 100;
          const half = percent === 0 || percent === 100 ? 12 : 8;
          return <line key={`marker-${percent}`} x1={x - normal.x * half} y1={y - normal.y * half} x2={x + normal.x * half} y2={y + normal.y * half} />;
        })}
        {markerPercents.map((percent) => valueLabel(percent, 27))}
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
    const center = getObjectCenter(object);
    return `rotate(${object.rotation * 180 / Math.PI} ${center.x} ${center.y})`;
  }

  function renderObject(sourceObject: GraphicObject) {
    if (sourceObject.hidden) return null;
    const object = resolveObject(sourceObject);
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
          const corners = getDisplayCorners(object);
          return <polygon points={corners.map((point) => `${point.x},${point.y}`).join(' ')} fill="transparent" stroke="transparent" strokeWidth={hitStroke} />;
        }
      }
    })();
    return <g key={sourceObject.id} data-object-id={sourceObject.id} className={sourceObject.locked ? 'object-locked' : ''}>{content}{hit}</g>;
  }

  function selectionOverlay() {
    if (!selectedResolvedObjects.length) return null;
    const pad = 8 / view.zoom;
    const radius = 6 / view.zoom;
    if (selectedResolvedObjects.length > 1) {
      const bounds = unionBounds(selectedResolvedObjects);
      if (!bounds) return null;
      return (
        <g data-ui-only="true" pointerEvents="none">
          {selectedResolvedObjects.map((object) => {
            const corners = getDisplayCorners(object);
            return <polygon key={object.id} points={corners.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#9b91ef" strokeWidth={1.1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />;
          })}
          <rect x={bounds.x - pad} y={bounds.y - pad} width={Math.max(1, bounds.width + pad * 2)} height={Math.max(1, bounds.height + pad * 2)} fill="none" stroke="#5648df" strokeWidth={1.8} strokeDasharray="8 5" vectorEffect="non-scaling-stroke" />
        </g>
      );
    }

    if (!selectedObject || !selectedResolvedObject) return null;
    const object = selectedResolvedObject;
    const handle = (name: ResizeHandle, point: Point) => (
      <circle
        key={name}
        data-resize-handle={name}
        data-resize-object-id={selectedObject.id}
        className={`resize-handle resize-${name}`}
        cx={point.x}
        cy={point.y}
        r={radius}
        fill="#ffffff"
        stroke="#5648df"
        strokeWidth={1.8}
        vectorEffect="non-scaling-stroke"
        pointerEvents="all"
      />
    );
    if (object.type === 'line' || object.type === 'arrow' || object.type === 'segment') {
      return (
        <g data-ui-only="true">
          <line x1={object.start.x} y1={object.start.y} x2={object.end.x} y2={object.end.y} fill="none" stroke="#6455ea" strokeWidth={1.6} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" pointerEvents="none" />
          {!selectedObject.locked && <>{handle('start', object.start)}{handle('end', object.end)}</>}
        </g>
      );
    }

    const corners = getDisplayCorners(object);
    const handles = selectedObject.locked ? null : <>
      {handle('nw', corners[0])}
      {handle('ne', corners[1])}
      {handle('se', corners[2])}
      {handle('sw', corners[3])}
    </>;
    const center = getObjectCenter(object);
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const topDistance = Math.max(0.001, distance(center, topMid));
    const rotationHandlePoint = { x: topMid.x + (topMid.x - center.x) / topDistance * (28 / view.zoom), y: topMid.y + (topMid.y - center.y) / topDistance * (28 / view.zoom) };
    const rotatable = !selectedObject.locked && 'rotation' in object && !(object.type === 'ellipse' && Math.abs(object.rx - object.ry) < 0.001);
    const polygonVertices = object.type === 'polygon' && !selectedObject.locked ? object.points.map((point) => displayedPoint(object, point)) : [];
    return (
      <g data-ui-only="true">
        <polygon points={corners.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#6455ea" strokeWidth={1.6} strokeDasharray="7 5" className="selection-outline" vectorEffect="non-scaling-stroke" pointerEvents="none" />
        {handles}
        {rotatable && <g className="rotation-handle-group"><line x1={topMid.x} y1={topMid.y} x2={rotationHandlePoint.x} y2={rotationHandlePoint.y} stroke="#5648df" strokeWidth={1.3} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" pointerEvents="none" /><circle data-rotate-object-id={selectedObject.id} className="rotation-handle" cx={rotationHandlePoint.x} cy={rotationHandlePoint.y} r={6 / view.zoom} fill="#fff" stroke="#5648df" strokeWidth={1.8} vectorEffect="non-scaling-stroke" pointerEvents="all" /><path d={`M ${rotationHandlePoint.x - 2.8 / view.zoom} ${rotationHandlePoint.y} A ${3 / view.zoom} ${3 / view.zoom} 0 1 1 ${rotationHandlePoint.x + 2.2 / view.zoom} ${rotationHandlePoint.y - 2.2 / view.zoom}`} fill="none" stroke="#5648df" strokeWidth={1.1} vectorEffect="non-scaling-stroke" pointerEvents="none" /></g>}
        {polygonVertices.map((point, index) => (
          <circle
            key={`vertex-${index}`}
            data-vertex-index={index}
            data-vertex-object-id={selectedObject.id}
            className="vertex-handle"
            cx={point.x}
            cy={point.y}
            r={5.2 / view.zoom}
            fill="#fff7df"
            stroke="#df8a22"
            strokeWidth={1.7}
            vectorEffect="non-scaling-stroke"
            pointerEvents="all"
          />
        ))}
        {polygonVertices.map((point, index) => {
          const next = polygonVertices[(index + 1) % polygonVertices.length];
          const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
          return <rect key={`add-${index}`} data-vertex-add-index={index + 1} data-vertex-object-id={selectedObject.id} className="vertex-add-handle" x={midpoint.x - 3.8 / view.zoom} y={midpoint.y - 3.8 / view.zoom} width={7.6 / view.zoom} height={7.6 / view.zoom} transform={`rotate(45 ${midpoint.x} ${midpoint.y})`} fill="#ffffff" stroke="#df8a22" strokeWidth={1.4} vectorEffect="non-scaling-stroke" pointerEvents="all" />;
        })}
      </g>
    );
  }


  function renderAxes() {
    if (!project.canvas.axesVisible) return null;
    const visible = { xMin: view.x, xMax: view.x + visibleWorldWidth, yMin: view.y, yMax: view.y + visibleWorldHeight };
    const tick = Math.max(0, project.canvas.tickInterval);
    const label = Math.max(0, project.canvas.labelInterval);
    const labelValid = tick === 0 ? label === 0 : label === 0 || Math.abs(label / tick - Math.round(label / tick)) < 1e-7;
    const elements: React.ReactNode[] = [];
    elements.push(<line key="x-axis" x1={visible.xMin} y1={coordinateOrigin.y} x2={visible.xMax} y2={coordinateOrigin.y} stroke="#596176" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />);
    elements.push(<line key="y-axis" x1={coordinateOrigin.x} y1={visible.yMin} x2={coordinateOrigin.x} y2={visible.yMax} stroke="#596176" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />);
    const arrowSize = 8 / view.zoom;
    elements.push(<path key="x-arrow" d={`M ${visible.xMax - arrowSize * 1.8} ${coordinateOrigin.y - arrowSize} L ${visible.xMax} ${coordinateOrigin.y} L ${visible.xMax - arrowSize * 1.8} ${coordinateOrigin.y + arrowSize}`} fill="none" stroke="#596176" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />);
    elements.push(<path key="y-arrow" d={`M ${coordinateOrigin.x - arrowSize} ${visible.yMin + arrowSize * 1.8} L ${coordinateOrigin.x} ${visible.yMin} L ${coordinateOrigin.x + arrowSize} ${visible.yMin + arrowSize * 1.8}`} fill="none" stroke="#596176" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />);
    elements.push(<text key="x-axis-name" x={visible.xMax - 15 / view.zoom} y={coordinateOrigin.y - 12 / view.zoom} textAnchor="middle" fontSize={15 / view.zoom} fontStyle="italic" fontWeight={600} fill="#444c61">x</text>);
    elements.push(<text key="y-axis-name" x={coordinateOrigin.x + 13 / view.zoom} y={visible.yMin + 18 / view.zoom} textAnchor="start" fontSize={15 / view.zoom} fontStyle="italic" fontWeight={600} fill="#444c61">y</text>);
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
    return <g pointerEvents="none">{elements}</g>;
  }

  const viewBox = `${view.x} ${view.y} ${visibleWorldWidth} ${visibleWorldHeight}`;
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

  async function screenshotInstant() {
    if (!svgRef.current || screenshotBusy) return;
    setScreenshotBusy(true);
    setScreenshotMenuOpen(false);
    try {
      setStatus('インスタント画像を生成しています');
      await openSvgAsPng(svgRef.current, project.canvas.background);
      setStatus('スクリーンショットを新しいウィンドウに表示しました');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'スクリーンショットを生成できませんでした');
      setStatus('スクリーンショットの生成に失敗しました');
    } finally {
      setScreenshotBusy(false);
    }
  }

  async function screenshotToClipboard() {
    if (!svgRef.current || screenshotBusy) return;
    setScreenshotBusy(true);
    setScreenshotMenuOpen(false);
    try {
      setStatus('クリップボード用画像を生成しています');
      await copySvgPngToClipboard(svgRef.current, project.canvas.background);
      setStatus('プロットエリアをクリップボードにコピーしました');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'クリップボードにコピーできませんでした');
      setStatus('クリップボードへのコピーに失敗しました');
    } finally {
      setScreenshotBusy(false);
    }
  }

  async function captureFourShot() {
    if (!svgRef.current || screenshotBusy) return;
    setScreenshotBusy(true);
    setScreenshotMenuOpen(false);
    const previewWindow = fourShotCaptures.length === 3 ? createPngPreviewWindow() : null;
    try {
      const capture = await captureSvgAsPng(svgRef.current, project.canvas.background);
      const next = [...fourShotCaptures, capture];
      if (next.length < 4) {
        setFourShotCaptures(next);
        setStatus(`4ショット: ${next.length}枚目を記録しました。次は${next.length + 1}枚目です`);
      } else {
        setStatus('4ショット画像を合成しています');
        const composed = await composeFourCaptures(next);
        if (previewWindow) showPngInPreview(previewWindow, composed.dataUrl, '左上・右上・左下・右下の順に4枚を配置しています。');
        setFourShotCaptures([]);
        setStatus('4ショットを新しいウィンドウに表示しました');
      }
    } catch (error) {
      previewWindow?.close();
      window.alert(error instanceof Error ? error.message : '4ショットを生成できませんでした');
      setStatus('4ショットの生成に失敗しました');
    } finally {
      setScreenshotBusy(false);
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
    setModal({ kind: 'math', point: { x: view.x + visibleWorldWidth / 2, y: view.y + visibleWorldHeight / 2 }, value: expression.source });
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
          <div className="screenshot-menu-wrap">
            <button type="button" className={fourShotCaptures.length ? 'is-capturing' : ''} disabled={screenshotBusy} onClick={() => fourShotCaptures.length ? captureFourShot() : setScreenshotMenuOpen((open) => !open)}><Icon name="camera" size={19} />{fourShotCaptures.length ? <span className="shot-next-number">{fourShotCaptures.length + 1}</span> : <span>スクショ</span>}</button>
            <button type="button" className="screenshot-menu-toggle" aria-label="スクリーンショットメニュー" aria-expanded={screenshotMenuOpen} onClick={() => setScreenshotMenuOpen((open) => !open)}>⌄</button>
            {screenshotMenuOpen && <div className="screenshot-dropdown" role="menu">
              <button type="button" role="menuitem" onClick={screenshotInstant}><Icon name="camera" size={18} /><span><strong>インスタント</strong><small>新規ウィンドウに1枚出力</small></span></button>
              <button type="button" role="menuitem" onClick={captureFourShot}><Icon name="grid" size={18} /><span><strong>4ショット</strong><small>4枚を順に記録して4分割</small></span></button>
              <button type="button" role="menuitem" onClick={screenshotToClipboard}><Icon name="duplicate" size={18} /><span><strong>クリップボード</strong><small>画像だけをコピー</small></span></button>
            </div>}
          </div>
          <button type="button" onClick={togglePresentation}><Icon name="fullscreen" size={19} /><span>発表</span></button>
          <button type="button" aria-label="設定" title="設定" onClick={() => setModal({ kind: 'settings' })}><Icon name="settings" size={19} /></button>
        </nav>
        <div className="view-control" aria-label="表示倍率"><button type="button" onClick={() => setView({ x: coordinateOrigin.x - viewportSize.width / 2, y: coordinateOrigin.y - viewportSize.height / 2, zoom: 1 })}>全体表示</button><output>{Math.round(view.zoom * 100)}%</output></div>
        <input className="project-title" value={project.title} aria-label="プロジェクト名" title="プロジェクト名" onChange={(event) => setProject((current) => ({ ...current, title: event.target.value }))} />
        <button type="button" className="wordmark" onClick={() => setModal({ kind: 'about' })}><strong>Graphanta</strong><span>visual mathematics</span></button>
      </header>

      <main className={`workspace toolbar-${settings.toolbarSide} ${panelCollapsed.tweak && panelCollapsed.expressions ? 'panels-collapsed' : ''}`}>
        {settings.toolbarSide === 'left' && <Toolbar tools={visibleTools} activeTool={activeTool} side="left" onChange={chooseTool} />}
        <section className="plot-shell">
          <div className="plot-viewport" ref={plotViewportRef}>
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
              onContextMenu={(event) => event.preventDefault()}
              onDragStart={(event) => event.preventDefault()}
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
              <rect x={view.x} y={view.y} width={visibleWorldWidth} height={visibleWorldHeight} fill={project.canvas.background} />
              {project.canvas.gridVisible && <rect x={view.x} y={view.y} width={visibleWorldWidth} height={visibleWorldHeight} fill={project.canvas.axesVisible ? 'url(#coordinate-grid)' : 'url(#pixel-grid)'} />}
              {renderAxes()}
              {project.objects.map(renderObject)}
              {polygonPoints.length > 0 && <g data-ui-only="true" pointerEvents="none"><polyline points={polygonPoints.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#6d5dfc" strokeWidth={2} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />{polygonPoints.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={5 / view.zoom} fill="#6d5dfc" />)}</g>}
              {zoomBox && <rect data-ui-only="true" pointerEvents="none" {...normalizeRect(zoomBox.start, zoomBox.end)} fill="rgba(86,72,223,.12)" stroke="#5648df" strokeWidth={1.5} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />}
              {selectionBox && <rect data-ui-only="true" pointerEvents="none" {...normalizeRect(selectionBox.start, selectionBox.end)} fill="rgba(86,72,223,.09)" stroke="#5648df" strokeWidth={1.4} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />}
              {snapIndicator && <g data-ui-only="true" pointerEvents="none" className={`snap-indicator snap-${snapIndicator.kind ?? 'grid'}`}>
                <circle cx={snapIndicator.point.x} cy={snapIndicator.point.y} r={7 / view.zoom} fill="rgba(255,255,255,.86)" stroke="#ee7b2d" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
                <line x1={snapIndicator.point.x - 10 / view.zoom} y1={snapIndicator.point.y} x2={snapIndicator.point.x + 10 / view.zoom} y2={snapIndicator.point.y} stroke="#ee7b2d" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                <line x1={snapIndicator.point.x} y1={snapIndicator.point.y - 10 / view.zoom} x2={snapIndicator.point.x} y2={snapIndicator.point.y + 10 / view.zoom} stroke="#ee7b2d" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
              </g>}
              {selectionOverlay()}
            </svg>
            {contextToolMenu && <div className="plot-context-tools" style={{ left: Math.min(contextToolMenu.clientX, window.innerWidth - contextToolMenu.tools.length * 48 - 18), top: Math.min(contextToolMenu.clientY, window.innerHeight - 62) }} role="menu" aria-label="現在のツールグループ">
              {contextToolMenu.tools.map((tool) => <button key={tool} type="button" role="menuitem" className={activeTool === tool ? 'is-active' : ''} title={TOOL_LABELS[tool]} onClick={() => chooseTool(tool)}><Icon name={tool} size={21} /><span>{TOOL_LABELS[tool]}</span></button>)}
            </div>}
          </div>
          <footer className="status-bar"><span><strong>{TOOL_LABELS[activeTool]}</strong>　{status}</span><span>{project.objects.length}要素・オフライン保存</span></footer>
        </section>
        {settings.toolbarSide === 'right' && <Toolbar tools={visibleTools} activeTool={activeTool} side="right" onChange={chooseTool} />}

        <aside className="side-panels">
          <section className={`side-panel tweak-panel ${panelCollapsed.tweak ? 'collapsed' : ''}`}>
            <button type="button" className="panel-heading" aria-expanded={!panelCollapsed.tweak} title={panelCollapsed.tweak ? 'ツウィークを開く' : 'ツウィークを畳む'} onClick={() => setPanelCollapsed((current) => ({ ...current, tweak: !current.tweak }))}><span className="panel-title">ツウィーク</span><span className="panel-short">T</span><Icon name="chevron" size={18} /></button>
            <div className="panel-content tweak-content" aria-hidden={panelCollapsed.tweak}><TweakPanel
              project={project}
              activeTool={activeTool}
              selected={selectedObject}
              selectedObjects={selectedObjects}
              resolvedSelected={selectedResolvedObject}
              presets={presets}
              coordinateUnitPx={coordinateUnitPx}
              worldToCoordinate={worldToCoordinate}
              coordinateToWorld={coordinateToWorld}
              onPresetChange={(tool, patch) => setPresets((current) => ({ ...current, [tool]: { ...current[tool], ...patch } }))}
              onCanvasChange={(patch) => mutateProject((current) => ({ ...current, canvas: { ...current.canvas, ...patch } }))}
              onObjectChange={(updater) => selectedObject && updateObject(selectedObject.id, updater)}
              onDelete={deleteSelected}
              onDuplicate={duplicateSelected}
              onAlign={alignSelected}
              onArrange={arrangeSelected}
              onFinalizePolygon={finalizePolygon}
              polygonCount={polygonPoints.length}
              onCreateFromCoordinates={addObjectFromCoordinates}
            /></div>
          </section>
          <section className={`side-panel expression-panel ${panelCollapsed.expressions ? 'collapsed' : ''}`}>
            <button type="button" className="panel-heading" aria-expanded={!panelCollapsed.expressions} title={panelCollapsed.expressions ? 'fウィンドウを開く' : 'fウィンドウを畳む'} onClick={() => setPanelCollapsed((current) => ({ ...current, expressions: !current.expressions }))}><span className="panel-title">f　数式・変数</span><span className="panel-short">f</span><Icon name="chevron" size={18} /></button>
            <div className="panel-content" aria-hidden={panelCollapsed.expressions}><ExpressionPanel
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
            /></div>
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
  selectedObjects: GraphicObject[];
  resolvedSelected: GraphicObject | null;
  presets: ToolPresets;
  coordinateUnitPx: number;
  worldToCoordinate: (point: Point) => Point;
  coordinateToWorld: (point: Point) => Point;
  onPresetChange: <K extends keyof ToolPresets>(tool: K, patch: Partial<ToolPresets[K]>) => void;
  onCanvasChange: (patch: Partial<GraphantaProject['canvas']>) => void;
  onObjectChange: (updater: (object: GraphicObject) => GraphicObject) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onAlign: (mode: AlignMode) => void;
  onArrange: (mode: ArrangeMode) => void;
  onFinalizePolygon: () => void;
  polygonCount: number;
  onCreateFromCoordinates: (tool: 'line' | 'arrow' | 'ellipse') => void;
}

function TweakPanel(props: TweakPanelProps) {
  const { project, activeTool, selected, selectedObjects, resolvedSelected, presets, coordinateUnitPx, worldToCoordinate, coordinateToWorld, onPresetChange, onCanvasChange, onObjectChange, onDelete, onDuplicate, onAlign, onArrange, onFinalizePolygon, polygonCount, onCreateFromCoordinates } = props;
  const navigationMode = activeTool === 'select' || activeTool === 'pan' || activeTool === 'zoom';
  const showSelected = selectedObjects.length === 1 && Boolean(selected) && activeTool !== 'pan' && activeTool !== 'zoom' && (activeTool === 'select' || (selected ? toolForObject(selected) === activeTool : false));
  const patchObject = (changes: Partial<GraphicObject>) => onObjectChange((object) => ({ ...object, ...changes } as GraphicObject));

  if (activeTool === 'select' && selectedObjects.length > 1) {
    return <MultiSelectionEditor count={selectedObjects.length} onAlign={onAlign} onArrange={onArrange} onDelete={onDelete} onDuplicate={onDuplicate} />;
  }

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
        <Toggle label="点・交点・辺へ吸着" checked={project.canvas.snapPoints} onChange={(checked) => onCanvasChange({ snapPoints: checked })} />
      </>
    );
  }

  if (showSelected && selected) {
    return <SelectedObjectEditor object={selected} resolvedObject={resolvedSelected ?? selected} variables={project.variables} coordinateUnitPx={coordinateUnitPx} worldToCoordinate={worldToCoordinate} coordinateToWorld={coordinateToWorld} onPatch={patchObject} onChange={onObjectChange} onDelete={onDelete} onDuplicate={onDuplicate} />;
  }

  if (activeTool === 'pen') return <><PresetHeader label="フリーハンド" /><LineStyleEditor value={presets.pen} onChange={(patch) => onPresetChange('pen', patch)} /></>;
  if (activeTool === 'line' || activeTool === 'arrow') {
    const preset = presets[activeTool];
    return (
      <>
        <PresetHeader label={TOOL_LABELS[activeTool]} />
        <LineStyleEditor value={preset} onChange={(patch) => onPresetChange(activeTool, patch)} />
        <ExpressionPointField label="始点" value={preset.start} onChange={(point) => onPresetChange(activeTool, { start: point })} />
        <ExpressionPointField label="終点" value={preset.end} onChange={(point) => onPresetChange(activeTool, { end: point })} />
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
        <ExpressionPointField label="中心" value={presets.ellipse.center} onChange={(center) => onPresetChange('ellipse', { center })} />
        <Field label="長軸方向"><select value={presets.ellipse.majorAxis} onChange={(event) => onPresetChange('ellipse', { majorAxis: event.target.value as 'x' | 'y' })}><option value="x">横</option><option value="y">縦</option></select></Field>
        <Field label="長半径"><ExpressionRange value={presets.ellipse.majorRadiusExpr} variables={project.variables} fallback={2} min={0.1} max={50} step={0.1} onChange={(majorRadiusExpr) => onPresetChange('ellipse', { majorRadiusExpr })} /></Field>
        <Field label="短半径"><ExpressionRange value={presets.ellipse.minorRadiusExpr} variables={project.variables} fallback={2} min={0.1} max={50} step={0.1} onChange={(minorRadiusExpr) => onPresetChange('ellipse', { minorRadiusExpr, eccentricityExpr: '0' })} /></Field>
        <Field label="離心率"><ExpressionRange value={presets.ellipse.eccentricityExpr} variables={project.variables} fallback={0} min={0} max={0.999} step={0.01} onChange={(eccentricityExpr) => onPresetChange('ellipse', { eccentricityExpr })} /></Field>
        <button type="button" className="primary-button full" onClick={() => onCreateFromCoordinates('ellipse')}>数値から作成</button>
      </>
    );
  }
  if (activeTool === 'polygon') return <><PresetHeader label="多角形" /><ShapeStyleEditor value={presets.polygon} onChange={(patch) => onPresetChange('polygon', patch)} />{polygonCount > 0 && <button type="button" className="primary-button full" onClick={onFinalizePolygon} disabled={polygonCount < 3}>多角形を確定（{polygonCount}点）</button>}</>;
  if (activeTool === 'text') return <><PresetHeader label="文字" /><LineStyleEditor value={presets.text} onChange={(patch) => onPresetChange('text', patch)} /><Field label="文字サイズ"><RangeNumber value={presets.text.fontSize} min={8} max={160} step={1} onChange={(fontSize) => onPresetChange('text', { fontSize })} /></Field></>;
  if (activeTool === 'math') return <><PresetHeader label="数式" /><LineStyleEditor value={presets.math} onChange={(patch) => onPresetChange('math', patch)} /><Field label="文字サイズ"><RangeNumber value={presets.math.fontSize} min={8} max={160} step={1} onChange={(fontSize) => onPresetChange('math', { fontSize })} /></Field></>;
  if (activeTool === 'array') return <><PresetHeader label="アレー図" /><ArraySymbolStyleEditor value={presets.array} symbolSize={presets.array.symbolSize} onChange={(patch) => onPresetChange('array', patch)} /><ArrayFields value={presets.array} onChange={(patch) => onPresetChange('array', patch)} /></>;
  if (activeTool === 'ball' || activeTool === 'person') {
    const preset = presets[activeTool];
    return <><PresetHeader label={TOOL_LABELS[activeTool]} /><ArraySymbolStyleEditor value={preset} symbolSize={preset.symbolSize} onChange={(patch) => onPresetChange(activeTool, patch)} /><p className="panel-hint">クリックで1個ずつ配置。ドラッグで大きさを決めると、次の配置にも引き継がれます。</p></>;
  }
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

function ArraySymbolStyleEditor({ value, symbolSize, onChange }: { value: StylePreset; symbolSize: number; onChange: (patch: Partial<StylePreset> & { symbolSize?: number }) => void }) {
  return (
    <>
      <Field label="色"><input type="color" value={value.stroke} onChange={(event) => onChange({ stroke: event.target.value, fill: event.target.value })} /></Field>
      <Field label="大きさ"><RangeNumber value={symbolSize} min={3} max={80} step={1} onChange={(next) => onChange({ symbolSize: next })} /></Field>
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

function MultiSelectionEditor({ count, onAlign, onArrange, onDelete, onDuplicate }: {
  count: number;
  onAlign: (mode: AlignMode) => void;
  onArrange: (mode: ArrangeMode) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  return (
    <>
      <div className="selected-type"><span>複数選択</span><code>{count}要素</code></div>
      <div className="inline-actions"><button type="button" onClick={onDuplicate}><Icon name="duplicate" size={18} />複製</button><button type="button" className="danger" onClick={onDelete}><Icon name="delete" size={18} />削除</button></div>
      <div className="subheading">整列</div>
      <div className="multi-action-grid">
        <button type="button" onClick={() => onAlign('left')}>左</button>
        <button type="button" onClick={() => onAlign('center')}>左右中央</button>
        <button type="button" onClick={() => onAlign('right')}>右</button>
        <button type="button" onClick={() => onAlign('top')}>上</button>
        <button type="button" onClick={() => onAlign('middle')}>上下中央</button>
        <button type="button" onClick={() => onAlign('bottom')}>下</button>
        <button type="button" onClick={() => onAlign('distributeX')} disabled={count < 3}>横に等間隔</button>
        <button type="button" onClick={() => onAlign('distributeY')} disabled={count < 3}>縦に等間隔</button>
      </div>
      <div className="subheading">重なり順</div>
      <div className="multi-action-grid two-columns">
        <button type="button" onClick={() => onArrange('front')}>最前面</button>
        <button type="button" onClick={() => onArrange('forward')}>一つ前へ</button>
        <button type="button" onClick={() => onArrange('backward')}>一つ後ろへ</button>
        <button type="button" onClick={() => onArrange('back')}>最背面</button>
      </div>
      <p className="panel-hint">Shift＋クリックで選択を追加・解除できます。空白部分をドラッグすると範囲選択になります。</p>
    </>
  );
}

function SelectedObjectEditor({ object, resolvedObject, variables, coordinateUnitPx, worldToCoordinate, onPatch, onChange, onDelete, onDuplicate }: {
  object: GraphicObject;
  resolvedObject: GraphicObject;
  variables: VariableDef[];
  coordinateUnitPx: number;
  worldToCoordinate: (point: Point) => Point;
  coordinateToWorld: (point: Point) => Point;
  onPatch: (patch: Partial<GraphicObject>) => void;
  onChange: (updater: (object: GraphicObject) => GraphicObject) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const setBinding = (key: string, value: string, clearKeys: string[] = []) => onChange((current) => {
    const bindings = { ...(current.bindings ?? {}) };
    clearKeys.forEach((item) => delete bindings[item]);
    if (value.trim()) bindings[key] = sanitizeExpression(value);
    else delete bindings[key];
    return { ...current, bindings } as GraphicObject;
  });
  const rotationFallback = resolvedObject.type === 'line' || resolvedObject.type === 'arrow' || resolvedObject.type === 'segment'
    ? coordinateAngleDegrees(resolvedObject.start, resolvedObject.end)
    : ('rotation' in resolvedObject ? normalizeDegrees(-(resolvedObject.rotation ?? 0) * RAD_TO_DEG) : 0);
  const rotationExpression = bindingExpression(object, 'rotationDeg', rotationFallback);
  const canRotate = object.type === 'pen' || object.type === 'line' || object.type === 'arrow' || object.type === 'rectangle' || object.type === 'ellipse' || object.type === 'polygon' || object.type === 'array' || object.type === 'segment';
  const circle = resolvedObject.type === 'ellipse' && Math.abs(resolvedObject.rx - resolvedObject.ry) < 0.001;
  return (
    <>
      <div className="selected-type"><span>{TOOL_LABELS[toolForObject(object)]}</span><code>{object.id.slice(0, 8)}</code></div>
      <div className="inline-actions"><button type="button" onClick={onDuplicate}><Icon name="duplicate" size={18} />複製</button><button type="button" className="danger" onClick={onDelete}><Icon name="delete" size={18} />削除</button></div>
      {object.type === 'array' ? <ArraySymbolStyleEditor value={object} symbolSize={object.symbolSize} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} /> : (object.type === 'rectangle' || object.type === 'ellipse' || object.type === 'polygon') ? <ShapeStyleEditor value={object} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} /> : <LineStyleEditor value={object} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} />}
      {canRotate && <RotationField value={rotationExpression} variables={variables} fallback={rotationFallback} disabled={circle} onChange={(value) => setBinding('rotationDeg', value)} />}
      <Toggle label="固定する" checked={Boolean(object.locked)} onChange={(checked) => onPatch({ locked: checked })} />
      {(object.type === 'line' || object.type === 'arrow' || object.type === 'segment') && (resolvedObject.type === 'line' || resolvedObject.type === 'arrow' || resolvedObject.type === 'segment') && <BoundLineCoordinateFields object={object} resolvedObject={resolvedObject} worldToCoordinate={worldToCoordinate} onBindingChange={setBinding} />}
      {object.type === 'arrow' && <Field label="矢じり"><RangeNumber value={object.arrowSize ?? 14} min={4} max={60} step={1} onChange={(arrowSize) => onPatch({ arrowSize } as Partial<GraphicObject>)} /></Field>}
      {object.type === 'rectangle' && resolvedObject.type === 'rectangle' && <><BoundBoxFields object={object} resolvedObject={resolvedObject} coordinateUnitPx={coordinateUnitPx} worldToCoordinate={worldToCoordinate} onBindingChange={setBinding} /><Field label="角の丸み"><AsciiNumber value={object.radius} min={0} max={100} onChange={(radius) => onPatch({ radius } as Partial<GraphicObject>)} /></Field></>}
      {object.type === 'ellipse' && resolvedObject.type === 'ellipse' && <BoundEllipseFields object={object} resolvedObject={resolvedObject} variables={variables} coordinateUnitPx={coordinateUnitPx} worldToCoordinate={worldToCoordinate} onBindingChange={setBinding} />}
      {object.type === 'text' && resolvedObject.type === 'text' && <><BoundPositionFields object={object} resolvedObject={resolvedObject} worldToCoordinate={worldToCoordinate} onBindingChange={setBinding} /><Field label="文字"><textarea value={object.text} onChange={(event) => onPatch({ text: event.target.value } as Partial<GraphicObject>)} /></Field><Field label="文字サイズ"><AsciiNumber value={object.fontSize} min={8} max={160} onChange={(fontSize) => onPatch({ fontSize } as Partial<GraphicObject>)} /></Field></>}
      {object.type === 'math' && resolvedObject.type === 'math' && <><BoundPositionFields object={object} resolvedObject={resolvedObject} worldToCoordinate={worldToCoordinate} onBindingChange={setBinding} /><Field label="数式"><AsciiText value={object.expression} onChange={(expression) => onPatch({ expression } as Partial<GraphicObject>)} /></Field><Field label="文字サイズ"><AsciiNumber value={object.fontSize} min={8} max={160} onChange={(fontSize) => onPatch({ fontSize } as Partial<GraphicObject>)} /></Field></>}
      {object.type === 'array' && resolvedObject.type === 'array' && <><BoundBoxFields object={object} resolvedObject={resolvedObject} coordinateUnitPx={coordinateUnitPx} worldToCoordinate={worldToCoordinate} onBindingChange={setBinding} /><ArrayFields value={object} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} /></>}
      {object.type === 'segment' && <MeasureFields value={object} onChange={(patch) => onPatch(patch as Partial<GraphicObject>)} />}
    </>
  );
}

function RotationField({ value, variables, fallback, disabled, onChange }: { value: string; variables: VariableDef[]; fallback: number; disabled?: boolean; onChange: (value: string) => void }) {
  const evaluated = normalizeDegrees(resolveNumber(value, variables, fallback));
  return <Field label="回転"><div className="range-direct expression-range"><input type="range" min={-180} max={180} step="1" value={evaluated} disabled={disabled} onChange={(event) => onChange(String(Number(event.target.value)))} /><AsciiText value={value} disabled={disabled} onChange={onChange} /><span>°</span></div></Field>;
}

function BoundLineCoordinateFields({ object, resolvedObject, worldToCoordinate, onBindingChange }: {
  object: LineObject | SegmentObject;
  resolvedObject: LineObject | SegmentObject;
  worldToCoordinate: (point: Point) => Point;
  onBindingChange: (key: string, value: string, clearKeys?: string[]) => void;
}) {
  const start = worldToCoordinate(resolvedObject.start);
  const end = worldToCoordinate(resolvedObject.end);
  return <><ExpressionPointField label="始点" value={{ x: bindingExpression(object, 'startX', start.x), y: bindingExpression(object, 'startY', start.y) }} onChange={(point) => { onBindingChange('startX', point.x, ['rotationDeg']); onBindingChange('startY', point.y, ['rotationDeg']); }} /><ExpressionPointField label="終点" value={{ x: bindingExpression(object, 'endX', end.x), y: bindingExpression(object, 'endY', end.y) }} onChange={(point) => { onBindingChange('endX', point.x, ['rotationDeg']); onBindingChange('endY', point.y, ['rotationDeg']); }} /></>;
}

function BoundBoxFields({ object, resolvedObject, coordinateUnitPx, worldToCoordinate, onBindingChange }: {
  object: RectangleObject | ArrayObject;
  resolvedObject: RectangleObject | ArrayObject;
  coordinateUnitPx: number;
  worldToCoordinate: (point: Point) => Point;
  onBindingChange: (key: string, value: string, clearKeys?: string[]) => void;
}) {
  const topLeft = worldToCoordinate({ x: resolvedObject.x, y: resolvedObject.y });
  return <><ExpressionPointField label="左上" value={{ x: bindingExpression(object, 'x', topLeft.x), y: bindingExpression(object, 'y', topLeft.y) }} onChange={(point) => { onBindingChange('x', point.x); onBindingChange('y', point.y); }} /><Field label="幅"><AsciiText value={bindingExpression(object, 'width', resolvedObject.width / coordinateUnitPx)} onChange={(value) => onBindingChange('width', value)} /></Field><Field label="高さ"><AsciiText value={bindingExpression(object, 'height', resolvedObject.height / coordinateUnitPx)} onChange={(value) => onBindingChange('height', value)} /></Field></>;
}

function BoundPositionFields({ object, resolvedObject, worldToCoordinate, onBindingChange }: {
  object: TextObject | MathObject;
  resolvedObject: TextObject | MathObject;
  worldToCoordinate: (point: Point) => Point;
  onBindingChange: (key: string, value: string, clearKeys?: string[]) => void;
}) {
  const position = worldToCoordinate({ x: resolvedObject.x, y: resolvedObject.y });
  return <ExpressionPointField label="位置" value={{ x: bindingExpression(object, 'x', position.x), y: bindingExpression(object, 'y', position.y) }} onChange={(point) => { onBindingChange('x', point.x); onBindingChange('y', point.y); }} />;
}

function BoundEllipseFields({ object, resolvedObject, variables, coordinateUnitPx, worldToCoordinate, onBindingChange }: {
  object: EllipseObject;
  resolvedObject: EllipseObject;
  variables: VariableDef[];
  coordinateUnitPx: number;
  worldToCoordinate: (point: Point) => Point;
  onBindingChange: (key: string, value: string, clearKeys?: string[]) => void;
}) {
  const center = worldToCoordinate({ x: resolvedObject.cx, y: resolvedObject.cy });
  const axis = object.majorAxis ?? (resolvedObject.rx >= resolvedObject.ry ? 'x' : 'y');
  const major = (axis === 'x' ? resolvedObject.rx : resolvedObject.ry) / coordinateUnitPx;
  const minor = (axis === 'x' ? resolvedObject.ry : resolvedObject.rx) / coordinateUnitPx;
  const eccentricity = major > 0 ? Math.sqrt(Math.max(0, 1 - (minor * minor) / (major * major))) : 0;
  return <><ExpressionPointField label="中心" value={{ x: bindingExpression(object, 'centerX', center.x), y: bindingExpression(object, 'centerY', center.y) }} onChange={(point) => { onBindingChange('centerX', point.x); onBindingChange('centerY', point.y); }} /><Field label="長半径"><ExpressionRange value={bindingExpression(object, 'majorRadius', major)} variables={variables} fallback={major} min={0.1} max={50} step={0.1} onChange={(value) => onBindingChange('majorRadius', value)} /></Field><Field label="短半径"><ExpressionRange value={bindingExpression(object, 'minorRadius', minor)} variables={variables} fallback={minor} min={0.1} max={50} step={0.1} onChange={(value) => onBindingChange('minorRadius', value, ['eccentricity'])} /></Field><Field label="離心率"><ExpressionRange value={bindingExpression(object, 'eccentricity', eccentricity)} variables={variables} fallback={eccentricity} min={0} max={0.999} step={0.01} onChange={(value) => onBindingChange('eccentricity', value)} /></Field></>;
}

function ArrayFields({ value, onChange }: { value: Pick<ArrayObject, 'rowsExpr' | 'colsExpr' | 'symbol'>; onChange: (patch: Partial<ArrayObject>) => void }) {
  return <><Field label="行数"><AsciiText value={value.rowsExpr} onChange={(rowsExpr) => onChange({ rowsExpr })} /></Field><Field label="列数"><AsciiText value={value.colsExpr} onChange={(colsExpr) => onChange({ colsExpr })} /></Field><Field label="シンボル"><select value={value.symbol} onChange={(event) => onChange({ symbol: event.target.value as ArrayObject['symbol'] })}><option value="circle">円</option><option value="square">四角</option><option value="dot">点</option><option value="cross">×</option><option value="ball">玉</option><option value="person">人</option></select></Field></>;
}

type MeasureValue = Pick<SegmentObject, 'mode' | 'tickIntervalExpr' | 'labelIntervalExpr' | 'maxValueExpr' | 'divisionPercents' | 'showMaxValue'>;

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
      {value.mode === 'numberLine' ? <><Field label="目盛り"><AsciiText value={value.tickIntervalExpr} invalid={invalid && tick <= 0} onChange={(tickIntervalExpr) => onChange({ tickIntervalExpr })} /></Field><Field label="数値"><AsciiText value={value.labelIntervalExpr} invalid={invalid} onChange={(labelIntervalExpr) => onChange({ labelIntervalExpr })} /></Field>{invalid && <p className="field-error">「数値」は「目盛り」の整数倍にしてください。</p>}<Field label="最大値"><AsciiText value={value.maxValueExpr} onChange={(maxValueExpr) => onChange({ maxValueExpr })} /></Field></> : <><Field label="最大値"><AsciiText value={value.maxValueExpr} onChange={(maxValueExpr) => onChange({ maxValueExpr })} /></Field><label className="subtle-check"><input type="checkbox" checked={value.showMaxValue} onChange={(event) => onChange({ showMaxValue: event.target.checked })} /><span>最大値を表示</span></label><div className="division-heading"><span>内分点</span><button type="button" onClick={addDivision}>＋</button></div>{value.divisionPercents.map((percent, index) => <Field key={index} label={`点${index + 1}`}><RangeNumber value={roundValue(percent, 2)} min={0} max={100} step={1} suffix="%" onChange={(next) => setDivision(index, next)} /><button type="button" className="mini-delete" aria-label={`点${index + 1}を削除`} onClick={() => onChange({ divisionPercents: value.divisionPercents.filter((_, itemIndex) => itemIndex !== index) })}>×</button></Field>)}</>}
    </>
  );
}

function ExpressionPointField({ label, value, onChange }: { label: string; value: ExpressionPoint; onChange: (point: ExpressionPoint) => void }) {
  return <Field label={label}><div className="point-input"><label>x<AsciiText value={value.x} onChange={(x) => onChange({ ...value, x })} /></label><label>y<AsciiText value={value.y} onChange={(y) => onChange({ ...value, y })} /></label></div></Field>;
}

function ExpressionRange({ value, variables, fallback, min, max, step, onChange }: { value: string; variables: VariableDef[]; fallback: number; min: number; max: number; step: number; onChange: (value: string) => void }) {
  const evaluated = clamp(resolveNumber(value, variables, fallback), min, max);
  return <div className="range-number expression-range"><input type="range" min={min} max={max} step={step} value={evaluated} onChange={(event) => onChange(String(Number(event.target.value)))} /><AsciiText value={value} onChange={onChange} /></div>;
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

function AsciiText({ value, invalid = false, disabled = false, onChange }: { value: string; invalid?: boolean; disabled?: boolean; onChange: (value: string) => void }) {
  return <input type="text" inputMode="text" className={invalid ? 'is-invalid' : ''} aria-invalid={invalid || undefined} disabled={disabled} value={value} onChange={(event) => onChange(sanitizeExpression(event.target.value))} />;
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
