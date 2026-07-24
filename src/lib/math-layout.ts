export interface MathMeasure {
  width: number;
  height: number;
  baseline: number;
  valid: boolean;
  error?: string;
}

interface TextDraw {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number;
  italic: boolean;
  weight?: number;
}

interface LineDraw {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
}

interface PathDraw {
  kind: 'path';
  d: string;
  strokeWidth: number;
}

export type MathDraw = TextDraw | LineDraw | PathDraw;
type Draw = MathDraw;

interface Layout {
  width: number;
  height: number;
  baseline: number;
  draws: Draw[];
}

type MathNode =
  | { type: 'atom'; value: string; italic: boolean }
  | { type: 'sequence'; items: MathNode[] }
  | { type: 'binary'; operator: '+' | '-' | '*' | '/' | '='; left: MathNode; right: MathNode }
  | { type: 'scripts'; base: MathNode; superscript?: MathNode; subscript?: MathNode }
  | { type: 'root'; body: MathNode }
  | { type: 'absolute'; body: MathNode }
  | { type: 'group'; body: MathNode }
  | { type: 'function'; name: string; args: MathNode[] };

type TokenKind = 'number' | 'identifier' | 'operator' | 'left' | 'right' | 'comma';
interface Token { kind: TokenKind; value: string; }

class MathParseError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(character)) {
      const start = index;
      let dots = character === '.' ? 1 : 0;
      index += 1;
      while (index < source.length && /[0-9.]/.test(source[index])) {
        if (source[index] === '.') dots += 1;
        if (dots > 1) break;
        index += 1;
      }
      tokens.push({ kind: 'number', value: source.slice(start, index) });
      continue;
    }
    if (/[A-Za-zπ]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9π]/.test(source[index])) index += 1;
      tokens.push({ kind: 'identifier', value: source.slice(start, index) });
      continue;
    }
    if ('+-*/^_='.includes(character)) {
      tokens.push({ kind: 'operator', value: character });
      index += 1;
      continue;
    }
    if (character === '(') {
      tokens.push({ kind: 'left', value: character });
      index += 1;
      continue;
    }
    if (character === ')') {
      tokens.push({ kind: 'right', value: character });
      index += 1;
      continue;
    }
    if (character === ',') {
      tokens.push({ kind: 'comma', value: character });
      index += 1;
      continue;
    }
    throw new MathParseError(`未対応の記号です: ${character}`);
  }
  return tokens;
}

class MathParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): MathNode {
    if (this.tokens.length === 0) return { type: 'atom', value: '', italic: false };
    const node = this.parseEquality();
    if (this.current()) throw new MathParseError(`「${this.current()?.value ?? ''}」の前後を解釈できません`);
    return node;
  }

  private current(): Token | undefined {
    return this.tokens[this.index];
  }

  private consume(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new MathParseError('式が途中で終わっています');
    this.index += 1;
    return token;
  }

  private matches(kind: TokenKind, value?: string): boolean {
    const token = this.current();
    return Boolean(token && token.kind === kind && (value === undefined || token.value === value));
  }

  private parseEquality(): MathNode {
    let node = this.parseAdditive();
    while (this.matches('operator', '=')) {
      this.consume();
      node = { type: 'binary', operator: '=', left: node, right: this.parseAdditive() };
    }
    return node;
  }

  private parseAdditive(): MathNode {
    let node = this.parseMultiplicative();
    while (this.matches('operator', '+') || this.matches('operator', '-')) {
      const operator = this.consume().value as '+' | '-';
      node = { type: 'binary', operator, left: node, right: this.parseMultiplicative() };
    }
    return node;
  }

  private parseMultiplicative(): MathNode {
    let node = this.parseUnary();
    while (this.matches('operator', '*') || this.matches('operator', '/')) {
      const operator = this.consume().value as '*' | '/';
      node = { type: 'binary', operator, left: node, right: this.parseUnary() };
    }
    return node;
  }

  private parseUnary(): MathNode {
    if (this.matches('operator', '+') || this.matches('operator', '-')) {
      const operator = this.consume().value;
      const body = this.parseUnary();
      if (operator === '+') return body;
      return { type: 'sequence', items: [{ type: 'atom', value: '−', italic: false }, body] };
    }
    return this.parseScripts();
  }

  private parseScripts(): MathNode {
    let base = this.parsePrimary();
    let superscript: MathNode | undefined;
    let subscript: MathNode | undefined;
    while (this.matches('operator', '^') || this.matches('operator', '_')) {
      const operator = this.consume().value;
      const script = this.parseScriptArgument();
      if (operator === '^') superscript = script;
      else subscript = script;
    }
    if (superscript || subscript) base = { type: 'scripts', base, superscript, subscript };
    return base;
  }

  private parseScriptArgument(): MathNode {
    if (this.matches('left')) {
      this.consume();
      const body = this.parseEquality();
      if (!this.matches('right')) throw new MathParseError('指数・添字の閉じ括弧が必要です');
      this.consume();
      return body;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): MathNode {
    const token = this.consume();
    if (token.kind === 'number') return { type: 'atom', value: token.value, italic: false };
    if (token.kind === 'identifier') {
      const displayName = token.value === 'pi' ? 'π' : token.value;
      if (this.matches('left')) {
        this.consume();
        const args: MathNode[] = [];
        if (!this.matches('right')) {
          args.push(this.parseEquality());
          while (this.matches('comma')) {
            this.consume();
            args.push(this.parseEquality());
          }
        }
        if (!this.matches('right')) throw new MathParseError(`${token.value} の閉じ括弧が必要です`);
        this.consume();
        if (token.value === 'sqrt' && args.length === 1) return { type: 'root', body: args[0] };
        if (token.value === 'abs' && args.length === 1) return { type: 'absolute', body: args[0] };
        if (token.value === 'frac' && args.length === 2) return { type: 'binary', operator: '/', left: args[0], right: args[1] };
        return { type: 'function', name: displayName, args };
      }
      return { type: 'atom', value: displayName, italic: true };
    }
    if (token.kind === 'left') {
      const body = this.parseEquality();
      if (!this.matches('right')) throw new MathParseError('閉じ括弧が必要です');
      this.consume();
      return { type: 'group', body };
    }
    throw new MathParseError(`「${token.value}」を式の要素として解釈できません`);
  }
}

function characterWidth(character: string, fontSize: number): number {
  if (/[il1.,]/.test(character)) return fontSize * 0.31;
  if (/[mwMW]/.test(character)) return fontSize * 0.82;
  if (/[+−=·×]/.test(character)) return fontSize * 0.7;
  if (/[()|]/.test(character)) return fontSize * 0.38;
  if (/[0-9]/.test(character)) return fontSize * 0.54;
  if (character === 'π') return fontSize * 0.58;
  return fontSize * 0.56;
}

function measureText(text: string, fontSize: number): number {
  return [...text].reduce((total, character) => total + characterWidth(character, fontSize), 0);
}

function offsetDraw(draw: Draw, x: number, y: number): Draw {
  if (draw.kind === 'text') return { ...draw, x: draw.x + x, y: draw.y + y };
  if (draw.kind === 'line') return { ...draw, x1: draw.x1 + x, x2: draw.x2 + x, y1: draw.y1 + y, y2: draw.y2 + y };
  return { ...draw, d: translatePath(draw.d, x, y) };
}

function translatePath(path: string, x: number, y: number): string {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers) return path;
  let index = 0;
  return path.replace(/-?\d+(?:\.\d+)?/g, (value) => {
    const numeric = Number(value);
    const translated = numeric + (index % 2 === 0 ? x : y);
    index += 1;
    return String(Number(translated.toFixed(4)));
  });
}

function atomLayout(value: string, fontSize: number, italic: boolean): Layout {
  const ascent = fontSize * 0.78;
  const descent = fontSize * 0.22;
  return {
    width: Math.max(value ? measureText(value, fontSize) : fontSize * 0.25, 0.01),
    height: ascent + descent,
    baseline: ascent,
    draws: value ? [{ kind: 'text', x: 0, y: ascent, text: value, fontSize, italic }] : [],
  };
}

function sequenceLayout(items: Layout[], fontSize: number, gap = 0): Layout {
  if (items.length === 0) return atomLayout('', fontSize, false);
  const baseline = Math.max(...items.map((item) => item.baseline));
  const descent = Math.max(...items.map((item) => item.height - item.baseline));
  let x = 0;
  const draws: Draw[] = [];
  items.forEach((item, index) => {
    const y = baseline - item.baseline;
    item.draws.forEach((draw) => draws.push(offsetDraw(draw, x, y)));
    x += item.width;
    if (index < items.length - 1) x += gap;
  });
  return { width: x, height: baseline + descent, baseline, draws };
}

function fractionLayout(numeratorNode: MathNode, denominatorNode: MathNode, fontSize: number): Layout {
  const childSize = fontSize * 0.82;
  const numerator = layoutNode(numeratorNode, childSize);
  const denominator = layoutNode(denominatorNode, childSize);
  const sidePadding = fontSize * 0.18;
  const lineGap = fontSize * 0.12;
  const lineWidth = Math.max(fontSize * 0.055, 1);
  const width = Math.max(numerator.width, denominator.width) + sidePadding * 2;
  const numeratorX = (width - numerator.width) / 2;
  const numeratorY = 0;
  const lineY = numerator.height + lineGap;
  const denominatorX = (width - denominator.width) / 2;
  const denominatorY = lineY + lineGap + lineWidth;
  const baseline = lineY + fontSize * 0.27;
  const height = denominatorY + denominator.height;
  const draws: Draw[] = [];
  numerator.draws.forEach((draw) => draws.push(offsetDraw(draw, numeratorX, numeratorY)));
  draws.push({ kind: 'line', x1: 0, y1: lineY, x2: width, y2: lineY, strokeWidth: lineWidth });
  denominator.draws.forEach((draw) => draws.push(offsetDraw(draw, denominatorX, denominatorY)));
  return { width, height, baseline, draws };
}

function scriptsLayout(node: Extract<MathNode, { type: 'scripts' }>, fontSize: number): Layout {
  const base = layoutNode(node.base, fontSize);
  const scriptSize = fontSize * 0.62;
  const superscript = node.superscript ? layoutNode(node.superscript, scriptSize) : null;
  const subscript = node.subscript ? layoutNode(node.subscript, scriptSize) : null;
  const scriptWidth = Math.max(superscript?.width ?? 0, subscript?.width ?? 0);
  const scriptGap = fontSize * 0.06;
  const baseTop = superscript ? Math.max(0, superscript.height - fontSize * 0.28) : 0;
  const baseline = baseTop + base.baseline;
  const superscriptY = superscript ? Math.max(0, baseline - fontSize * 0.82 - superscript.height * 0.45) : 0;
  const subscriptY = subscript ? baseline + fontSize * 0.1 : 0;
  const height = Math.max(baseTop + base.height, superscript ? superscriptY + superscript.height : 0, subscript ? subscriptY + subscript.height : 0);
  const draws: Draw[] = [];
  base.draws.forEach((draw) => draws.push(offsetDraw(draw, 0, baseTop)));
  if (superscript) superscript.draws.forEach((draw) => draws.push(offsetDraw(draw, base.width + scriptGap, superscriptY)));
  if (subscript) subscript.draws.forEach((draw) => draws.push(offsetDraw(draw, base.width + scriptGap, subscriptY)));
  return { width: base.width + (scriptWidth ? scriptGap + scriptWidth : 0), height, baseline, draws };
}

function rootLayout(bodyNode: MathNode, fontSize: number): Layout {
  const body = layoutNode(bodyNode, fontSize * 0.9);
  const rootWidth = fontSize * 0.55;
  const topPadding = fontSize * 0.13;
  const bodyX = rootWidth + fontSize * 0.03;
  const bodyY = topPadding;
  const baseline = bodyY + body.baseline;
  const bottom = bodyY + body.height;
  const strokeWidth = Math.max(fontSize * 0.05, 1);
  const checkStartX = fontSize * 0.04;
  const checkStartY = baseline - fontSize * 0.08;
  const checkMidX = fontSize * 0.2;
  const checkMidY = baseline + fontSize * 0.2;
  const checkPeakX = rootWidth * 0.82;
  const checkPeakY = topPadding;
  const width = bodyX + body.width + fontSize * 0.06;
  const draws: Draw[] = [
    { kind: 'path', d: `M ${checkStartX} ${checkStartY} L ${checkMidX} ${checkMidY} L ${checkPeakX} ${checkPeakY} L ${width} ${checkPeakY}`, strokeWidth },
  ];
  body.draws.forEach((draw) => draws.push(offsetDraw(draw, bodyX, bodyY)));
  return { width, height: Math.max(bottom, checkMidY + strokeWidth), baseline, draws };
}

function groupLayout(bodyNode: MathNode, fontSize: number): Layout {
  const body = layoutNode(bodyNode, fontSize);
  const bracketSize = Math.max(fontSize, body.height * 0.92);
  const left = atomLayout('(', bracketSize, false);
  const right = atomLayout(')', bracketSize, false);
  const baseline = Math.max(body.baseline, left.baseline, right.baseline);
  return sequenceLayout([left, body, right], fontSize, fontSize * 0.04 + Math.max(0, baseline - body.baseline) * 0.01);
}

function absoluteLayout(bodyNode: MathNode, fontSize: number): Layout {
  const body = layoutNode(bodyNode, fontSize);
  const padding = fontSize * 0.13;
  const lineWidth = Math.max(fontSize * 0.045, 1);
  const width = body.width + padding * 2 + lineWidth * 2;
  const draws: Draw[] = [
    { kind: 'line', x1: lineWidth / 2, y1: 0, x2: lineWidth / 2, y2: body.height, strokeWidth: lineWidth },
    { kind: 'line', x1: width - lineWidth / 2, y1: 0, x2: width - lineWidth / 2, y2: body.height, strokeWidth: lineWidth },
  ];
  body.draws.forEach((draw) => draws.push(offsetDraw(draw, padding + lineWidth, 0)));
  return { width, height: body.height, baseline: body.baseline, draws };
}

function functionLayout(node: Extract<MathNode, { type: 'function' }>, fontSize: number): Layout {
  if ((node.name === 'sum' || node.name === 'Σ') && node.args.length === 1) {
    return sequenceLayout([atomLayout('Σ', fontSize * 1.12, false), layoutNode(node.args[0], fontSize)], fontSize, fontSize * 0.08);
  }
  if ((node.name === 'int' || node.name === '∫') && node.args.length === 1) {
    return sequenceLayout([atomLayout('∫', fontSize * 1.2, false), layoutNode(node.args[0], fontSize)], fontSize, fontSize * 0.08);
  }
  const name = atomLayout(node.name, fontSize * 0.88, false);
  const args = node.args.map((arg) => layoutNode(arg, fontSize));
  const comma = atomLayout(',', fontSize, false);
  const joined: Layout[] = [];
  args.forEach((arg, index) => {
    if (index > 0) joined.push(comma);
    joined.push(arg);
  });
  const body = sequenceLayout(joined, fontSize, fontSize * 0.04);
  return sequenceLayout([name, parenthesizedLayout(body, fontSize)], fontSize, fontSize * 0.03);
}

function parenthesizedLayout(body: Layout, fontSize: number): Layout {
  const bracketSize = Math.max(fontSize, body.height * 0.92);
  const left = atomLayout('(', bracketSize, false);
  const right = atomLayout(')', bracketSize, false);
  return sequenceLayout([left, body, right], fontSize, fontSize * 0.03);
}

function layoutNode(node: MathNode, fontSize: number): Layout {
  switch (node.type) {
    case 'atom':
      return atomLayout(node.value, fontSize, node.italic);
    case 'sequence':
      return sequenceLayout(node.items.map((item) => layoutNode(item, fontSize)), fontSize, fontSize * 0.025);
    case 'binary': {
      if (node.operator === '/') return fractionLayout(node.left, node.right, fontSize);
      const operator = node.operator === '*' ? '·' : node.operator === '-' ? '−' : node.operator;
      return sequenceLayout(
        [layoutNode(node.left, fontSize), atomLayout(operator, fontSize, false), layoutNode(node.right, fontSize)],
        fontSize,
        node.operator === '*' ? fontSize * 0.08 : fontSize * 0.14,
      );
    }
    case 'scripts':
      return scriptsLayout(node, fontSize);
    case 'root':
      return rootLayout(node.body, fontSize);
    case 'absolute':
      return absoluteLayout(node.body, fontSize);
    case 'group':
      return groupLayout(node.body, fontSize);
    case 'function':
      return functionLayout(node, fontSize);
  }
}

function fallbackLayout(source: string, fontSize: number): Layout {
  const normalized = source
    .replace(/\*/g, '·')
    .replace(/\^2\b/g, '²')
    .replace(/\^3\b/g, '³')
    .replace(/sqrt\s*\(/g, '√(')
    .replace(/pi\b/g, 'π');
  return atomLayout(normalized, fontSize, true);
}

export function buildMathLayout(source: string, fontSize: number): MathMeasure & { draws: Draw[] } {
  const normalized = source.trim();
  if (!normalized) {
    const empty = atomLayout('', fontSize, false);
    return { ...empty, valid: true };
  }
  try {
    const node = new MathParser(tokenize(normalized)).parse();
    const layout = layoutNode(node, fontSize);
    return { ...layout, valid: true };
  } catch (error) {
    const fallback = fallbackLayout(normalized, fontSize);
    return { ...fallback, valid: false, error: error instanceof Error ? error.message : '数式を解釈できません' };
  }
}

export function measureMathExpression(source: string, fontSize: number): MathMeasure {
  const { width, height, baseline, valid, error } = buildMathLayout(source, fontSize);
  return { width, height, baseline, valid, error };
}

