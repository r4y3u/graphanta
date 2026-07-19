import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

function errorText(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason ?? '不明なエラー');
}

function showFatalError(reason: unknown): void {
  const root = document.getElementById('root');
  if (!root || root.dataset.fatalShown === 'true') return;
  root.dataset.fatalShown = 'true';
  root.replaceChildren();

  const box = document.createElement('main');
  box.style.cssText = 'max-width:760px;margin:8vh auto;padding:28px;border:1px solid #d8dceb;border-radius:18px;background:#fff;box-shadow:0 20px 60px rgba(30,40,80,.12);font-family:system-ui,sans-serif;color:#20263a';
  const title = document.createElement('h1');
  title.textContent = 'Graphantaを起動できませんでした';
  title.style.cssText = 'font-size:24px;margin:0 0 14px';
  const body = document.createElement('p');
  body.textContent = 'ブラウザを最新版のEdgeまたはChromeに変更して、もう一度開いてください。下の情報は不具合確認に使用できます。';
  body.style.cssText = 'line-height:1.7';
  const detail = document.createElement('pre');
  detail.textContent = errorText(reason);
  detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;border-radius:10px;background:#f2f4fa;font-size:13px';
  box.append(title, body, detail);
  root.appendChild(box);
}

window.addEventListener('error', (event) => showFatalError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showFatalError(event.reason));

try {
  const root = document.getElementById('root');
  if (!root) throw new Error('描画先の要素が見つかりません');
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  showFatalError(error);
}

const isWebProtocol = location.protocol === 'https:' || location.protocol === 'http:';
if ('serviceWorker' in navigator && import.meta.env.PROD && isWebProtocol) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
