function waitForImage(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('SVGの画像化に失敗しました'));
  });
}

export interface PngCapture {
  dataUrl: string;
  blob: Blob;
  width: number;
  height: number;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'image/png';
  const bytes = atob(payload);
  const buffer = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) buffer[index] = bytes.charCodeAt(index);
  return new Blob([buffer], { type: mime });
}

export async function captureSvgAsPng(svgElement: SVGSVGElement, background: string): Promise<PngCapture> {
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.querySelectorAll('[data-ui-only="true"]').forEach((element) => element.remove());

  const viewBox = svgElement.viewBox.baseVal;
  const width = Math.max(1, Math.round(svgElement.clientWidth || viewBox.width || 1280));
  const height = Math.max(1, Math.round(svgElement.clientHeight || viewBox.height || 800));
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  clone.querySelectorAll<SVGElement>('*').forEach((element) => {
    const key = element.getAttribute('data-export-key');
    if (!key) return;
    const source = svgElement.querySelector(`[data-export-key="${CSS.escape(key)}"]`);
    if (!source) return;
    const style = getComputedStyle(source);
    if (!element.getAttribute('font-family') && style.fontFamily) element.setAttribute('font-family', style.fontFamily);
  });

  const serializer = new XMLSerializer();
  const svgText = serializer.serializeToString(clone);
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  const image = new Image();
  image.decoding = 'async';
  image.src = encoded;
  await waitForImage(image);

  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvasを初期化できません');
  context.scale(scale, scale);
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, blob: dataUrlToBlob(dataUrl), width: canvas.width, height: canvas.height };
}

export function createPngPreviewWindow(): Window {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) throw new Error('新しいウィンドウを開けませんでした。ポップアップの許可を確認してください');
  try { previewWindow.opener = null; } catch { /* noop */ }
  previewWindow.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Graphanta スクリーンショット</title><style>html,body{margin:0;min-height:100%;background:#eef1f8;font-family:system-ui,sans-serif}.box{min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;text-align:center}.status{margin:0 0 12px;color:#445}.image{display:none;max-width:100%;height:auto;background:#fff;box-shadow:0 18px 55px rgba(22,27,45,.18)}</style></head><body><div class="box"><div><p class="status">画像を生成しています…</p><img class="image" alt="Graphanta screenshot"></div></div></body></html>`);
  previewWindow.document.close();
  return previewWindow;
}

export function showPngInPreview(previewWindow: Window, dataUrl: string, message = '画像を長押し・右クリックしてコピーまたは保存できます。'): void {
  if (previewWindow.closed) throw new Error('スクリーンショット表示用ウィンドウが閉じられました');
  const status = previewWindow.document.querySelector<HTMLElement>('.status');
  const output = previewWindow.document.querySelector<HTMLImageElement>('img');
  if (status) status.textContent = message;
  if (output) {
    output.src = dataUrl;
    output.style.display = 'block';
  }
}

export function openPngPreview(dataUrl: string, message?: string): void {
  const previewWindow = createPngPreviewWindow();
  showPngInPreview(previewWindow, dataUrl, message);
}

export async function openSvgAsPng(svgElement: SVGSVGElement, background: string): Promise<void> {
  const previewWindow = createPngPreviewWindow();
  try {
    const capture = await captureSvgAsPng(svgElement, background);
    showPngInPreview(previewWindow, capture.dataUrl);
  } catch (error) {
    previewWindow.close();
    throw error;
  }
}

export async function copySvgPngToClipboard(svgElement: SVGSVGElement, background: string): Promise<void> {
  const capture = await captureSvgAsPng(svgElement, background);
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('この環境では画像のクリップボードコピーを利用できません');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': capture.blob })]);
}

export async function composeFourCaptures(captures: PngCapture[]): Promise<PngCapture> {
  if (captures.length !== 4) throw new Error('4枚の画像が必要です');
  const cellWidth = Math.max(...captures.map((capture) => capture.width));
  const cellHeight = Math.max(...captures.map((capture) => capture.height));
  const canvas = document.createElement('canvas');
  canvas.width = cellWidth * 2;
  canvas.height = cellHeight * 2;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('4ショット画像を生成できません');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < captures.length; index += 1) {
    const image = new Image();
    image.src = captures[index].dataUrl;
    await waitForImage(image);
    const x = (index % 2) * cellWidth;
    const y = Math.floor(index / 2) * cellHeight;
    context.drawImage(image, x, y, cellWidth, cellHeight);
  }
  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, blob: dataUrlToBlob(dataUrl), width: canvas.width, height: canvas.height };
}
