function waitForImage(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('SVGの画像化に失敗しました'));
  });
}

export async function openSvgAsPng(svgElement: SVGSVGElement, background: string): Promise<void> {
  // The window must be opened synchronously from the click event to avoid popup blocking.
  const previewWindow = window.open('', '_blank');
  if (previewWindow) {
    try { previewWindow.opener = null; } catch { /* Browser may disallow this assignment. */ }
    previewWindow.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Graphanta スクリーンショット</title><style>html,body{margin:0;min-height:100%;background:#eef1f8;font-family:system-ui,sans-serif}.box{min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;text-align:center}.status{margin:0 0 12px;color:#445}.image{display:block;max-width:100%;height:auto;background:#fff;box-shadow:0 18px 55px rgba(22,27,45,.18)}</style></head><body><div class="box"><div><p class="status">画像を生成しています…</p></div></div></body></html>`);
    previewWindow.document.close();
  }

  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.querySelectorAll('[data-ui-only="true"]').forEach((element) => element.remove());

  const viewBox = svgElement.viewBox.baseVal;
  const width = Math.max(1, Math.round(svgElement.clientWidth || viewBox.width || 1280));
  const height = Math.max(1, Math.round(svgElement.clientHeight || viewBox.height || 800));
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Browser stylesheets are not available to an SVG loaded as an image. Inline the
  // few computed properties that can otherwise disappear in a file:// build.
  clone.querySelectorAll<SVGElement>('*').forEach((element) => {
    const source = svgElement.querySelector(`[data-export-key="${element.getAttribute('data-export-key') ?? ''}"]`);
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

  // A data URL works across the opaque origins used by directly opened file:// HTML.
  const pngDataUrl = canvas.toDataURL('image/png');
  if (previewWindow && !previewWindow.closed) {
    previewWindow.document.body.innerHTML = `<div class="box"><div><p class="status">画像を長押し・右クリックしてコピーまたは保存できます。</p><img class="image" alt="Graphanta screenshot"></div></div>`;
    const output = previewWindow.document.querySelector<HTMLImageElement>('img');
    if (output) output.src = pngDataUrl;
  } else {
    const fallback = window.open(pngDataUrl, '_blank');
    if (!fallback) throw new Error('新しいウィンドウを開けませんでした。ポップアップの許可を確認してください');
  }
}
