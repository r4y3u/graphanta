import type { GraphantaProject, GraphantaSettings } from '../types';

const SETTINGS_KEY = 'graphanta.settings.v1';
const DB_NAME = 'graphanta-local';
const STORE_NAME = 'documents';
const AUTOSAVE_KEY = 'autosave';

export function saveSettingsLocal(settings: GraphantaSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadSettingsLocal(): GraphantaSettings | null {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GraphantaSettings;
    return parsed.format === 'graphanta-settings' ? parsed : null;
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
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
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(project, AUTOSAVE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function loadAutosave(): Promise<GraphantaProject | null> {
  const db = await openDatabase();
  const result = await new Promise<GraphantaProject | null>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(AUTOSAVE_KEY);
    request.onsuccess = () => resolve((request.result as GraphantaProject | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
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
