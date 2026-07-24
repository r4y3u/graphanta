import type { ReactNode } from 'react';
import { buildMathLayout } from '../lib/math-layout';

interface StructuredMathProps {
  source: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  opacity?: number;
  className?: string;
}

export function StructuredMath({ source, x, y, fontSize, color, opacity = 1, className }: StructuredMathProps) {
  const layout = buildMathLayout(source, fontSize);
  const content: ReactNode[] = layout.draws.map((draw, index) => {
    if (draw.kind === 'text') {
      return (
        <text
          key={index}
          x={draw.x}
          y={draw.y}
          fontSize={draw.fontSize}
          fontFamily="Georgia, 'Times New Roman', 'Noto Serif', serif"
          fontStyle={draw.italic ? 'italic' : 'normal'}
          fontWeight={draw.weight ?? 400}
          fill={color}
          stroke="none"
        >
          {draw.text}
        </text>
      );
    }
    if (draw.kind === 'line') {
      return <line key={index} x1={draw.x1} y1={draw.y1} x2={draw.x2} y2={draw.y2} stroke={color} strokeWidth={draw.strokeWidth} strokeLinecap="square" vectorEffect="non-scaling-stroke" />;
    }
    return <path key={index} d={draw.d} fill="none" stroke={color} strokeWidth={draw.strokeWidth} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
  });
  return <g className={className} transform={`translate(${x} ${y - layout.baseline})`} opacity={opacity}>{content}</g>;
}

interface MathPreviewProps {
  source: string;
  fontSize?: number;
  className?: string;
  color?: string;
  minWidth?: number;
}

export function MathPreview({ source, fontSize = 34, className, color = '#252d43', minWidth = 80 }: MathPreviewProps) {
  const layout = buildMathLayout(source, fontSize);
  const padding = Math.max(8, fontSize * 0.28);
  const width = Math.max(minWidth, layout.width + padding * 2);
  const height = Math.max(fontSize * 1.5, layout.height + padding * 2);
  const x = (width - layout.width) / 2;
  const y = (height - layout.height) / 2 + layout.baseline;
  return (
    <svg className={className} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={source ? `数式 ${source}` : '数式プレビュー'} preserveAspectRatio="xMidYMid meet">
      <StructuredMath source={source} x={x} y={y} fontSize={fontSize} color={color} />
    </svg>
  );
}
