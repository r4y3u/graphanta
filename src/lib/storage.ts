import type { GraphantaProject, GraphantaSettings } from '../types';

const SETTINGS_KEY = 'graphanta.settings.v1';
const DB_NAME = 'graphanta-local';
const STORE_NAME = 'documents';
const AUTOSAVE_KEY = 'autosave';

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

export async function saveAutosave(project: GraphantaProject): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(project, AUTOSAVE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAutosave(): Promise<GraphantaProject | null> {
  const db = await openDatabase();
  try {
    return await new Promise<GraphantaProject | null>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(AUTOSAVE_KEY);
      request.onsuccess = () => resolve((request.result as GraphantaProject | undefined) ?? null);
      request.onerror = () => reject(request.error);
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
