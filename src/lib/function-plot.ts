import type { Point, VariableDef } from '../types';
import { compileExpression, variableMap } from './math';

export interface FunctionPlotRange {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  samples: number;
}

export interface FunctionPlotSample {
  body: string | null;
  segments: Point[][];
  error?: string;
}

export function explicitFunctionBody(source: string): string | null {
  const match = source.trim().match(/^y\s*=\s*(.+)$/i);
  const body = match?.[1]?.trim() ?? '';
  return body || null;
}

export function sampleExplicitFunction(
  source: string,
  variables: VariableDef[],
  range: FunctionPlotRange,
): FunctionPlotSample {
  const body = explicitFunctionBody(source);
  if (!body) return { body: null, segments: [] };

  let evaluate: ReturnType<typeof compileExpression>;
  try {
    evaluate = compileExpression(body);
  } catch (error) {
    return { body, segments: [], error: error instanceof Error ? error.message : '式を解釈できません' };
  }

  const sampleCount = Math.max(80, Math.min(1200, Math.round(range.samples)));
  const xSpan = Math.max(1e-9, range.xMax - range.xMin);
  const ySpan = Math.max(1e-9, range.yMax - range.yMin);
  const yLimit = Math.max(10, Math.abs(range.yMin), Math.abs(range.yMax)) + ySpan * 4;
  const values = variableMap(variables);
  const segments: Point[][] = [];
  let current: Point[] = [];
  let firstError: string | undefined;

  const finishSegment = () => {
    if (current.length >= 2) segments.push(current);
    current = [];
  };

  for (let index = 0; index <= sampleCount; index += 1) {
    const x = range.xMin + xSpan * index / sampleCount;
    values.x = x;

    let y: number;
    try {
      y = evaluate(values);
    } catch (error) {
      firstError ??= error instanceof Error ? error.message : '式を評価できません';
      finishSegment();
      continue;
    }

    if (!Number.isFinite(y) || Math.abs(y) > yLimit) {
      finishSegment();
      continue;
    }

    const point = { x, y };
    const previous = current.at(-1);
    if (previous && Math.abs(point.y - previous.y) > ySpan * 1.35) finishSegment();
    current.push(point);
  }

  finishSegment();
  return {
    body,
    segments,
    ...(segments.length === 0 && firstError ? { error: firstError } : {}),
  };
}
