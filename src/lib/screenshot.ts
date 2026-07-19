export async function openSvgAsPng(svgElement: SVGSVGElement, background: string): Promise<void> {
  const previewWindow = window.open('', '_blank', 'noopener,noreferrer');
  if (previewWindow) {
    previewWindow.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Graphanta スクリーンショット</title><style>body{margin:0;background:#eef1f8;display:grid;place-items:center;min-height:100vh;font-family:system-ui,sans-serif}.box{padding:24px;text-align:center}.status{margin-bottom:12px;color:#445}</style></head><body><div class="box"><div class="status">画像を生成しています…</div></div></body></html>`);
    previewWindow.document.close();
  }

  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(svgElement.viewBox.baseVal.width || svgElement.clientWidth));
  clone.setAttribute('height', String(svgElement.viewBox.baseVal.height || svgElement.clientHeight));
  clone.querySelectorAll('[data-ui-only="true"]').forEach((element) => element.remove());

  const serializer = new XMLSerializer();
  const svgText = serializer.serializeToString(clone);
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  const image = new Image();
  image.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('SVGの画像化に失敗しました'));
  });
  image.src = svgUrl;
  await loaded;

  const width = Math.max(1, Math.round(Number(clone.getAttribute('width'))));
  const height = Math.max(1, Math.round(Number(clone.getAttribute('height'))));
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
  URL.revokeObjectURL(svgUrl);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('PNG生成に失敗しました'))), 'image/png');
  });
  const pngUrl = URL.createObjectURL(blob);

  if (previewWindow) {
    previewWindow.document.body.innerHTML = `<div class="box"><div class="status">画像を長押し・右クリックしてコピーまたは保存できます。</div><img alt="Graphanta screenshot" style="display:block;max-width:100%;height:auto;box-shadow:0 18px 55px rgba(22,27,45,.18);background:white" /></div>`;
    const img = previewWindow.document.querySelector('img');
    if (img) img.setAttribute('src', pngUrl);
  } else {
    const fallback = document.createElement('a');
    fallback.href = pngUrl;
    fallback.target = '_blank';
    fallback.rel = 'noopener noreferrer';
    fallback.click();
  }
}
