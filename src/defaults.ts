import { createId } from './lib/geometry';
import type { GraphantaProject, GraphantaSettings, ToolId } from './types';

export const APP_VERSION = '0.2.0-alpha.3';

export const ALL_TOOLS: ToolId[] = [
  'select', 'pan', 'zoom', 'pen', 'line', 'arrow', 'rectangle', 'ellipse', 'polygon',
  'text', 'math', 'array', 'ball', 'person', 'segment', 'function',
];

export const BASIC_TOOLS: ToolId[] = [
  'select', 'pan', 'zoom', 'pen', 'line', 'arrow', 'rectangle', 'ellipse',
  'text', 'math', 'array', 'ball', 'person', 'segment', 'function',
];

export const TOOL_LABELS: Record<ToolId, string> = {
  select: '選択',
  pan: 'スクロール',
  zoom: 'ズーム',
  pen: 'フリーハンド',
  line: '線分',
  arrow: '矢印',
  rectangle: '四角形',
  ellipse: '円・だ円',
  polygon: '多角形',
  text: '文字',
  math: '数式',
  array: 'アレー図',
  ball: '玉',
  person: '人',
  segment: '目盛り',
  function: '関数グラフ（v3）',
};

export function createInitialProject(): GraphantaProject {
  return {
    format: 'graphanta-project',
    schemaVersion: 1,
    appVersion: APP_VERSION,
    title: '無題のプロジェクト',
    updatedAt: new Date().toISOString(),
    canvas: {
      width: 1280,
      height: 800,
      background: '#ffffff',
      gridVisible: true,
      axesVisible: false,
      gridSize: 20,
      coordinatePrecision: 10,
      tickInterval: 0,
      labelInterval: 0,
      snapGrid: true,
      snapPoints: false,
    },
    objects: [],
    expressions: [
      { id: createId('expr'), label: '式1', source: 'a=4', visible: true },
    ],
    variables: [
      { id: createId('var'), name: 'a', value: 4, min: 1, max: 12, step: 1 },
    ],
  };
}

export function createDefaultSettings(): GraphantaSettings {
  return {
    format: 'graphanta-settings',
    schemaVersion: 1,
    toolbarSide: 'right',
    visibleTools: BASIC_TOOLS,
    defaultStroke: '#25314d',
    defaultFill: 'transparent',
    defaultStrokeWidth: 2.5,
    autoRestore: true,
  };
}
