import type { GraphicObject, Point } from '../types';

function fallbackRandomId(): string {
  const randomPart = Math.random().toString(36).slice(2, 12);
  const timePart = Date.now().toString(36);
  return `${timePart}-${randomPart}`;
}

export function createId(prefix = 'obj'): string {
  const uuid = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : fallbackRandomId();
  return `${prefix}-${uuid}`;
}
export function snapPoint(point: Point, gridSize: number, enabled: boolean): Point {
  if (!enabled) return point;
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  };
}

export function normalizeRect(start: Point, end: Point): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function translateObject(object: GraphicObject, dx: number, dy: number): GraphicObject {
  switch (object.type) {
    case 'pen':
      return { ...object, points: object.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
    case 'line':
    case 'arrow':
    case 'segment':
      return {
        ...object,
        start: { x: object.start.x + dx, y: object.start.y + dy },
        end: { x: object.end.x + dx, y: object.end.y + dy },
      };
    case 'rectangle':
    case 'array':
      return { ...object, x: object.x + dx, y: object.y + dy };
    case 'ellipse':
      return { ...object, cx: object.cx + dx, cy: object.cy + dy };
    case 'polygon':
      return { ...object, points: object.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
    case 'text':
    case 'math':
      return { ...object, x: object.x + dx, y: object.y + dy };
  }
}

export function pointsToPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.reduce((path, point, index) => `${path}${index === 0 ? 'M' : ' L'} ${point.x} ${point.y}`, '');
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
