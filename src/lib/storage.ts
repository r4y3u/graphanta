import type { GraphantaProject, GraphantaSettings } from '../types';

const SETTINGS_KEY = 'graphanta.settings.v1';
const DB_NAME = 'graphanta-local';
const STORE_NAME = 'documents';
const AUTOSAVE_CURRENT_KEY = 'autosave.current';
const AUTOSAVE_PREVIOUS_KEY = 'autosave.previous';
const AUTOSAVE_LEGACY_KEY = 'autosave';

export interface AutosaveRecord {
  format: 'graphanta-autosave';
  schemaVersion: 1;
  savedAt: string;
  appVersion: string;
  project: GraphantaProject;
  contentFingerprint?: string;
  source?: 'current' | 'previous' | 'legacy';
}

function canUseLocalStorage(): boolean {
  try {
    const key = '__graphanta_storage_test__';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function saveSettingsLocal(settings: GraphantaSettings): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ファイル直開きや管理端末で保存が拒否されても、アプリ本体は継続する。
  }
}

export function loadSettingsLocal(): GraphantaSettings | null {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GraphantaSettings;
    return parsed.format === 'graphanta-settings' ? parsed : null;
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDBを利用できません'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function looksLikeProject(value: unknown): value is GraphantaProject {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GraphantaProject>;
  return candidate.format === 'graphanta-project'
    && candidate.schemaVersion === 1
    && Array.isArray(candidate.objects)
    && Array.isArray(candidate.expressions)
    && Array.isArray(candidate.variables);
}

function projectContentFingerprint(project: GraphantaProject): string {
  const { updatedAt: _updatedAt, appVersion: _appVersion, ...content } = project;
  const text = JSON.stringify(content);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function normalizeAutosave(value: unknown, source: AutosaveRecord['source']): AutosaveRecord | null {
  if (looksLikeProject(value)) {
    return {
      format: 'graphanta-autosave',
      schemaVersion: 1,
      savedAt: value.updatedAt || new Date(0).toISOString(),
      appVersion: value.appVersion || 'unknown',
      project: value,
      contentFingerprint: projectContentFingerprint(value),
      source: source ?? 'legacy',
    };
  }
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AutosaveRecord>;
  if (candidate.format !== 'graphanta-autosave' || candidate.schemaVersion !== 1 || !looksLikeProject(candidate.project)) return null;
  return {
    format: 'graphanta-autosave',
    schemaVersion: 1,
    savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : candidate.project.updatedAt,
    appVersion: typeof candidate.appVersion === 'string' ? candidate.appVersion : candidate.project.appVersion,
    project: candidate.project,
    contentFingerprint: typeof candidate.contentFingerprint === 'string'
      ? candidate.contentFingerprint
      : projectContentFingerprint(candidate.project),
    source,
  };
}

export async function saveAutosave(project: GraphantaProject): Promise<AutosaveRecord> {
  const db = await openDatabase();
  const fingerprint = projectContentFingerprint(project);
  const record: AutosaveRecord = {
    format: 'graphanta-autosave',
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    appVersion: project.appVersion,
    project: structuredClone(project),
    contentFingerprint: fingerprint,
    source: 'current',
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const currentRequest = store.get(AUTOSAVE_CURRENT_KEY);
      currentRequest.onsuccess = () => {
        const current = normalizeAutosave(currentRequest.result, 'current');
        if (current?.contentFingerprint !== fingerprint) {
          if (current) store.put({ ...current, source: undefined }, AUTOSAVE_PREVIOUS_KEY);
        }
        store.put({ ...record, source: undefined }, AUTOSAVE_CURRENT_KEY);
        store.delete(AUTOSAVE_LEGACY_KEY);
      };
      currentRequest.onerror = () => reject(currentRequest.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return record;
  } finally {
    db.close();
  }
}

export async function loadAutosaves(): Promise<AutosaveRecord[]> {
  const db = await openDatabase();
  try {
    const values = await new Promise<{ current: unknown; previous: unknown; legacy: unknown }>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const current = store.get(AUTOSAVE_CURRENT_KEY);
      const previous = store.get(AUTOSAVE_PREVIOUS_KEY);
      const legacy = store.get(AUTOSAVE_LEGACY_KEY);
      transaction.oncomplete = () => resolve({ current: current.result, previous: previous.result, legacy: legacy.result });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const candidates = [
      normalizeAutosave(values.current, 'current'),
      normalizeAutosave(values.previous, 'previous'),
      normalizeAutosave(values.legacy, 'legacy'),
    ].filter((record): record is AutosaveRecord => Boolean(record));
    const seen = new Set<string>();
    return candidates.filter((record) => {
      const fingerprint = record.contentFingerprint ?? projectContentFingerprint(record.project);
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
  } finally {
    db.close();
  }
}

export async function loadAutosave(): Promise<AutosaveRecord | null> {
  return (await loadAutosaves())[0] ?? null;
}

export async function clearAutosave(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.delete(AUTOSAVE_CURRENT_KEY);
      store.delete(AUTOSAVE_PREVIOUS_KEY);
      store.delete(AUTOSAVE_LEGACY_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readJsonFile<T>(file: File): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)) as T);
      } catch {
        reject(new Error('JSONファイルを読み取れませんでした'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読み取れませんでした'));
    reader.readAsText(file);
  });
}
