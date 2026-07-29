import { access, readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const execFileAsync = promisify(execFile);
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

const localOnlyDirectoryNames = new Set([
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

function checkForbiddenPath(repositoryPath) {
  const segments = repositoryPath.split('/');
  const directorySegments = segments.slice(0, -1);
  const fileName = segments.at(-1);

  const localOnlyDirectory = directorySegments.find((segment) => localOnlyDirectoryNames.has(segment));
  if (localOnlyDirectory) {
    failures.push(`収録禁止ディレクトリ内のファイルがGit管理されています: ${repositoryPath}`);
  }
  if (forbiddenFileNames.has(fileName)) {
    failures.push(`収録禁止ファイルがGit管理されています: ${repositoryPath}`);
  }
  if (forbiddenExtensions.has(extname(fileName).toLowerCase())) {
    failures.push(`一時・生成ファイルがGit管理されています: ${repositoryPath}`);
  }
}

async function trackedRepositoryPaths() {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '-z'],
      { encoding: 'utf8' },
    );
    return stdout.split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'));
  } catch {
    return null;
  }
}

async function walkSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const absolute = join(directory, entry.name);
    const repositoryPath = relative(root, absolute).replaceAll('\\', '/');

    if (entry.isDirectory()) {
      if (localOnlyDirectoryNames.has(entry.name)) continue;
      await walkSourceFiles(absolute);
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

const trackedPaths = await trackedRepositoryPaths();
if (trackedPaths) {
  for (const repositoryPath of trackedPaths) checkForbiddenPath(repositoryPath);
  notes.push(`Git管理対象: ${trackedPaths.length} files`);
} else {
  await walkSourceFiles(root);
  notes.push('Git管理情報なし: ローカル生成ディレクトリを除外して検証');
}

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

  const rootElementIndex = standalone.search(/<[^>]+\bid=["']root["'][^>]*>/i);
  const executableScriptIndex = standalone.search(/<script[\s>]/i);
  if (rootElementIndex < 0) {
    failures.push('index.htmlにアプリケーションのroot要素がありません');
  } else if (executableScriptIndex >= 0 && executableScriptIndex < rootElementIndex) {
    failures.push('index.htmlのJavaScriptがroot要素より前に同期実行されます');
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
