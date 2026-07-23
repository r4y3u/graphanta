export type ToolId =
  | 'select'
  | 'pan'
  | 'zoom'
  | 'pen'
  | 'line'
  | 'arrow'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'text'
  | 'math'
  | 'array'
  | 'ball'
  | 'person'
  | 'bundle'
  | 'segment'
  | 'function';

export interface Point {
  x: number;
  y: number;
}

export interface VariableDef {
  id: string;
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface ExpressionDef {
  id: string;
  label: string;
  source: string;
  visible: boolean;
}

export type GeometryBindings = Record<string, string>;

export interface BaseObject {
  id: string;
  stroke: string;
  fill: string;
  strokeWidth: number;
  opacity: number;
  locked?: boolean;
  hidden?: boolean;
  /** Objects sharing the same identifier are selected and moved as one group. */
  groupId?: string;
  /** Optional persistent pivot used by rotated freeform objects. */
  rotationCenter?: Point;
  /** Coordinate/geometry expressions evaluated against project variables. */
  bindings?: GeometryBindings;
}

export interface PenObject extends BaseObject {
  type: 'pen';
  points: Point[];
  rotation?: number;
}

export interface LineObject extends BaseObject {
  type: 'line' | 'arrow';
  start: Point;
  end: Point;
  arrowSize?: number;
}

export interface RectangleObject extends BaseObject {
  type: 'rectangle';
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  rotation?: number;
}

export interface EllipseObject extends BaseObject {
  type: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation?: number;
  majorAxis?: 'x' | 'y';
}

export interface PolygonObject extends BaseObject {
  type: 'polygon';
  points: Point[];
  rotation?: number;
}

export interface TextObject extends BaseObject {
  type: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontWeight: number;
  align: 'start' | 'middle' | 'end';
}

export interface MathObject extends BaseObject {
  type: 'math';
  x: number;
  y: number;
  expression: string;
  fontSize: number;
}

export interface ArrayObject extends BaseObject {
  type: 'array';
  x: number;
  y: number;
  width: number;
  height: number;
  rowsExpr: string;
  colsExpr: string;
  symbol: 'circle' | 'square' | 'dot' | 'cross' | 'ball' | 'person' | 'bundle';
  symbolSize: number;
  /** Number displayed inside a single 'bundle' symbol. */
  bundleValue?: number;
  rotation?: number;
}

export type MeasureMode = 'numberLine' | 'tape' | 'segment';

export interface SegmentObject extends BaseObject {
  type: 'segment';
  start: Point;
  end: Point;
  mode: MeasureMode;
  tickIntervalExpr: string;
  labelIntervalExpr: string;
  maxValueExpr: string;
  divisionPercents: number[];
  showMaxValue: boolean;
  rotation?: number;
  /** v0.1.0-alpha.3 compatibility */
  ticksExpr?: string;
  startValueExpr?: string;
  endValueExpr?: string;
  showValues?: boolean;
}

export type GraphicObject =
  | PenObject
  | LineObject
  | RectangleObject
  | EllipseObject
  | PolygonObject
  | TextObject
  | MathObject
  | ArrayObject
  | SegmentObject;

export interface CanvasSettings {
  width: number;
  height: number;
  background: string;
  gridVisible: boolean;
  axesVisible: boolean;
  gridSize: number;
  coordinatePrecision: number;
  tickInterval: number;
  labelInterval: number;
  snapGrid: boolean;
  snapPoints: boolean;
}

export interface GraphantaProject {
  format: 'graphanta-project';
  schemaVersion: 1;
  appVersion: string;
  title: string;
  updatedAt: string;
  canvas: CanvasSettings;
  objects: GraphicObject[];
  expressions: ExpressionDef[];
  variables: VariableDef[];
}

export interface GraphantaSettings {
  format: 'graphanta-settings';
  schemaVersion: 1;
  toolbarSide: 'left' | 'right';
  /** ツウィーク／fウィンドウを1組として配置する側。 */
  panelSide: 'left' | 'right';
  visibleTools: ToolId[];
  defaultStroke: string;
  defaultFill: string;
  defaultStrokeWidth: number;
  autoRestore: boolean;
}

export type DraftShape = GraphicObject | null;
