import { access, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];
const notes = [];

const requiredFiles = [
  'index.html',
  'app.html',
  'package.json',
  'package-lock.json',
  'AGENTS.md',
  'src/main.tsx',
  'scripts/build-standalone.mjs',
];

const forbiddenDirectoryNames = new Set([
  'node_modules',
  'dist',
  '.cache',
  '.vite',
  'coverage',
  '.turbo',
]);
const forbiddenFileNames = new Set([
  'deploy.yml',
  'deploy.yaml',
  '.DS_Store',
]);
const forbiddenExtensions = new Set([
  '.log',
  '.tmp',
  '.temp',
  '.swp',
  '.swo',
  '.tsbuildinfo',
]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const absolute = join(directory, entry.name);
    const repositoryPath = relative(root, absolute).replaceAll('\\', '/');

    if (entry.isDirectory()) {
      if (forbiddenDirectoryNames.has(entry.name)) {
        failures.push(`収録禁止ディレクトリがあります: ${repositoryPath}/`);
        continue;
      }
      await walk(absolute);
      continue;
    }

    if (forbiddenFileNames.has(entry.name)) {
      failures.push(`収録禁止ファイルがあります: ${repositoryPath}`);
    }
    if (forbiddenExtensions.has(extname(entry.name).toLowerCase())) {
      failures.push(`一時・生成ファイルがあります: ${repositoryPath}`);
    }
  }
}

for (const file of requiredFiles) {
  if (!(await exists(join(root, file)))) failures.push(`必須ファイルがありません: ${file}`);
}

await walk(root);

const standalonePath = join(root, 'index.html');
if (await exists(standalonePath)) {
  const standalone = await readFile(standalonePath, 'utf8');
  if (!standalone.includes('単体起動版')) {
    failures.push('index.htmlに単体起動版の識別コメントがありません');
  }
  if (!/<style[\s>]/i.test(standalone)) {
    failures.push('index.htmlに内包CSSが見つかりません');
  }
  if (!/<script[\s>]/i.test(standalone)) {
    failures.push('index.htmlに内包JavaScriptが見つかりません');
  }

  const externalAssetPattern = /<(?:script|link)\b[^>]*(?:src|href)=["'](?!data:|#)([^"']+)["']/gi;
  const externalAssets = [...standalone.matchAll(externalAssetPattern)].map((match) => match[1]);
  if (externalAssets.length > 0) {
    failures.push(`index.htmlに外部または別ファイル参照が残っています: ${externalAssets.join(', ')}`);
  }

  const size = (await stat(standalonePath)).size;
  notes.push(`index.html: ${(size / 1024).toFixed(1)} KiB`);
}

const packagePath = join(root, 'package.json');
if (await exists(packagePath)) {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  for (const scriptName of ['dev', 'check', 'build', 'verify:repo']) {
    if (!packageJson.scripts?.[scriptName]) {
      failures.push(`package.jsonのscripts.${scriptName}がありません`);
    }
  }
  if (!packageJson.engines?.node) {
    failures.push('package.jsonにNode.jsのengines指定がありません');
  }
}

if (failures.length > 0) {
  console.error('Repository verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Repository verification passed.');
  for (const note of notes) console.log(`- ${note}`);
  console.log('- 必須ファイル: OK');
  console.log('- 公開禁止ファイル: なし');
  console.log('- 単体index.htmlの外部資産参照: なし');
}
