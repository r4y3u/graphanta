import type { VariableDef } from '../types';

type Token =
  | { type: 'number'; value: number }
  | { type: 'identifier'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'comma'; value: ',' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const start = index;
      index += 1;
      while (index < input.length && /[0-9.eE+-]/.test(input[index])) {
        const candidate = input.slice(start, index + 1);
        if (!Number.isNaN(Number(candidate))) index += 1;
        else break;
      }
      const value = Number(input.slice(start, index));
      if (!Number.isFinite(value)) throw new Error('数値が不正です');
      tokens.push({ type: 'number', value });
      continue;
    }
    if (/[A-Za-z_π]/.test(char)) {
      const start = index;
      index += 1;
      while (index < input.length && /[A-Za-z0-9_]/.test(input[index])) index += 1;
      tokens.push({ type: 'identifier', value: input.slice(start, index) });
      continue;
    }
    if ('+-*/^'.includes(char)) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ type: 'comma', value: ',' });
      index += 1;
      continue;
    }
    throw new Error(`未対応の記号です: ${char}`);
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly variables: Record<string, number>,
  ) {}

  parse(): number {
    const value = this.parseAdditive();
    if (this.index < this.tokens.length) throw new Error('式の末尾を解釈できません');
    return value;
  }

  private current(): Token | undefined {
    return this.tokens[this.index];
  }

  private consume(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error('式が途中で終わっています');
    this.index += 1;
    return token;
  }

  private parseAdditive(): number {
    let value = this.parseMultiplicative();
    while (this.current()?.type === 'operator' && ['+', '-'].includes((this.current() as { value: string }).value)) {
      const operator = (this.consume() as { value: string }).value;
      const right = this.parseMultiplicative();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  private parseMultiplicative(): number {
    let value = this.parsePower();
    while (this.current()?.type === 'operator' && ['*', '/'].includes((this.current() as { value: string }).value)) {
      const operator = (this.consume() as { value: string }).value;
      const right = this.parsePower();
      if (operator === '/' && right === 0) throw new Error('0で割ることはできません');
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }

  private parsePower(): number {
    let value = this.parseUnary();
    if (this.current()?.type === 'operator' && (this.current() as { value: string }).value === '^') {
      this.consume();
      value = value ** this.parsePower();
    }
    return value;
  }

  private parseUnary(): number {
    if (this.current()?.type === 'operator') {
      const operator = (this.current() as { value: string }).value;
      if (operator === '+' || operator === '-') {
        this.consume();
        const value = this.parseUnary();
        return operator === '-' ? -value : value;
      }
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.consume();
    if (token.type === 'number') return token.value;
    if (token.type === 'paren' && token.value === '(') {
      const value = this.parseAdditive();
      const closing = this.consume();
      if (closing.type !== 'paren' || closing.value !== ')') throw new Error('閉じ括弧が必要です');
      return value;
    }
    if (token.type === 'identifier') {
      const name = token.value;
      if (this.current()?.type === 'paren' && (this.current() as { value: string }).value === '(') {
        this.consume();
        const args: number[] = [];
        if (!(this.current()?.type === 'paren' && (this.current() as { value: string }).value === ')')) {
          args.push(this.parseAdditive());
          while (this.current()?.type === 'comma') {
            this.consume();
            args.push(this.parseAdditive());
          }
        }
        const closing = this.consume();
        if (closing.type !== 'paren' || closing.value !== ')') throw new Error('関数の閉じ括弧が必要です');
        return callFunction(name, args);
      }
      if (name === 'pi' || name === 'π') return Math.PI;
      if (name === 'e') return Math.E;
      if (Object.prototype.hasOwnProperty.call(this.variables, name)) return this.variables[name];
      throw new Error(`変数 ${name} は未定義です`);
    }
    throw new Error('式を解釈できません');
  }
}

function callFunction(name: string, args: number[]): number {
  const unary: Record<string, (value: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
  };
  if (name in unary) {
    if (args.length !== 1) throw new Error(`${name} は引数を1つ取ります`);
    return unary[name](args[0]);
  }
  if (name === 'min') return Math.min(...args);
  if (name === 'max') return Math.max(...args);
  throw new Error(`未対応の関数です: ${name}`);
}

export function variableMap(variables: VariableDef[]): Record<string, number> {
  return Object.fromEntries(variables.map((item) => [item.name, item.value]));
}

export function evaluateExpression(source: string, variables: VariableDef[]): number {
  const normalized = source.trim().replace(/^=/, '');
  if (!normalized) throw new Error('式が空です');
  return new Parser(tokenize(normalized), variableMap(variables)).parse();
}

export function resolveNumber(source: string, variables: VariableDef[], fallback: number): number {
  try {
    const result = evaluateExpression(source, variables);
    return Number.isFinite(result) ? result : fallback;
  } catch {
    return fallback;
  }
}

export function prettyMath(source: string): string {
  return source
    .replace(/\*/g, '·')
    .replace(/\^2\b/g, '²')
    .replace(/\^3\b/g, '³')
    .replace(/sqrt\s*\(/g, '√(')
    .replace(/pi\b/g, 'π');
}
