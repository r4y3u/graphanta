import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const distDir = join(rootDir, 'dist');
const builtHtmlPath = join(distDir, 'app.html');
const serverIndexPath = join(distDir, 'index.html');

const builtHtml = await readFile(builtHtmlPath, 'utf8');
await copyFile(builtHtmlPath, serverIndexPath);

const scriptMatch = builtHtml.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/);
const styleMatches = [...builtHtml.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
if (!scriptMatch) throw new Error('ビルド済みJavaScriptを検出できませんでした');

const toAssetPath = (relativePath) => join(distDir, relativePath.replace(/^\.\//, ''));
const javascript = await readFile(toAssetPath(scriptMatch[1]), 'utf8');
const css = (await Promise.all(styleMatches.map((match) => readFile(toAssetPath(match[1]), 'utf8')))).join('\n');

let standalone = builtHtml
  .replace(/\s*<link[^>]*rel="manifest"[^>]*>/g, '')
  .replace(/\s*<link[^>]*rel="stylesheet"[^>]*>/g, '')
  // JavaScriptを埋め込む前に、実際のhead終端へCSSを挿入する。
  // バンドル内のHTML文字列に含まれる </head> を誤って置換しないための順序です。
  .replace('</head>', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style></head>`)
  .replace(scriptMatch[0], () => `<script type="module">${javascript.replace(/<\/script/gi, '<\\/script')}</script>`)
  .replace('<title>Graphanta</title>', '<title>Graphanta v0.2.0-alpha.3</title>');

const notice = '<!-- このHTMLは単体起動版です。EdgeまたはChromeで直接開けます。 -->\n';
standalone = standalone.replace('<!doctype html>', `<!doctype html>\n${notice}`);

await writeFile(join(rootDir, 'index.html'), standalone, 'utf8');
await writeFile(join(rootDir, 'Graphanta.html'), standalone, 'utf8');
await writeFile(join(distDir, 'Graphanta.html'), standalone, 'utf8');
await rm(builtHtmlPath);
