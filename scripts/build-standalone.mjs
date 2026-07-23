import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_VERSION = '0.2.0-alpha.6';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const distDir = resolve(rootDir, 'dist');
const builtHtmlPath = resolve(distDir, 'app.html');

const builtHtml = await readFile(builtHtmlPath, 'utf8');

async function localAssetPath(reference) {
  const withoutQuery = reference.replace(/[?#].*$/, '');
  const candidates = [];

  const resolvedUrl = new URL(withoutQuery, pathToFileURL(builtHtmlPath));
  if (resolvedUrl.protocol === 'file:') {
    candidates.push(fileURLToPath(resolvedUrl));
  }

  // GitHub Pagesのリポジトリ名を含む絶対パス
  // 例: /graphanta/assets/index.js を dist/assets/index.js として解決する。
  const normalizedReference = withoutQuery.replaceAll('\\', '/');
  const assetsIndex = normalizedReference.lastIndexOf('/assets/');
  if (assetsIndex >= 0) {
    candidates.push(resolve(distDir, normalizedReference.slice(assetsIndex + 1)));
  }
  candidates.push(resolve(distDir, normalizedReference.replace(/^\/+/, '')));

  for (const candidate of [...new Set(candidates)]) {
    const relative = candidate.slice(distDir.length);
    if (candidate !== distDir && !relative.startsWith('/') && !relative.startsWith('\\')) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 次の候補を確認する。
    }
  }

  throw new Error(`ビルド資産を解決できませんでした: ${reference}`);
}

const scriptMatches = [...builtHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi)];
const styleMatches = [...builtHtml.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)];

if (scriptMatches.length === 0) {
  throw new Error('ビルド済みJavaScriptを検出できませんでした');
}

const scripts = await Promise.all(
  scriptMatches.map(async (match) => ({
    tag: match[0],
    code: await readFile(await localAssetPath(match[1]), 'utf8'),
  })),
);
const styles = await Promise.all(
  styleMatches.map(async (match) => readFile(await localAssetPath(match[1]), 'utf8')),
);

let standalone = builtHtml
  .replace(/\s*<link\b[^>]*\brel=["'](?:manifest|modulepreload)["'][^>]*>/gi, '')
  .replace(/\s*<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi, '')
  .replace('</head>', () => `<style>${styles.join('\n').replace(/<\/style/gi, '<\\/style')}</style></head>`);

for (const { tag, code } of scripts) {
  standalone = standalone.replace(tag, () => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`);
}

standalone = standalone
  .replace('<title>Graphanta</title>', `<title>Graphanta v${APP_VERSION}</title>`)
  .replace('<!doctype html>', '<!doctype html>\n<!-- 単体起動版: CSS・JavaScriptを内包し、通信なしで動作します。 -->');

const remainingExternalAssets = [...standalone.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["'](?!data:|#)([^"']+)["']/gi)];
if (remainingExternalAssets.length > 0) {
  throw new Error(`単体版に外部資産参照が残っています: ${remainingExternalAssets.map((match) => match[1]).join(', ')}`);
}

await writeFile(resolve(rootDir, 'index.html'), standalone, 'utf8');
await writeFile(resolve(distDir, 'index.html'), standalone, 'utf8');
await copyFile(resolve(rootDir, 'sw.js'), resolve(distDir, 'sw.js'));
await copyFile(resolve(rootDir, 'manifest.webmanifest'), resolve(distDir, 'manifest.webmanifest'));
