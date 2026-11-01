export const MEDIA_TYPES = ['application/x-codex-workflow-media', 'application/x-mjr-asset', 'application/x-mjr-assets', 'application/x-comfy-asset-info', 'application/x-mtb-asset'];
export function isVideoFile(file) { return /^video\//i.test(file?.type || '') || /\.(mp4|webm|mov|mkv|m4v)$/i.test(file?.name || ''); }
export function isImageFile(file) { return /^image\/(png|jpeg|webp)$/i.test(file?.type || '') || /\.(png|jpe?g|webp)$/i.test(file?.name || ''); }
export function mediaFromURL(value) {
  try {
    const url = new URL(value, 'http://127.0.0.1:8000/');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '8000' || url.pathname !== '/view' || !['http:', 'https:'].includes(url.protocol)) return null;
    const filename = url.searchParams.get('filename'); if (!filename) return null;
    return { filename, type: url.searchParams.get('type') || 'output', subfolder: url.searchParams.get('subfolder') || '', kind: isVideoFile({ name: filename }) ? 'video' : 'image', url: url.href };
  } catch { return null; }
}
function normalize(value) {
  if (!value || typeof value !== 'object') return null;
  const url = value.originalUrl || value.url || value.preview_url;
  const fromURL = typeof url === 'string' ? mediaFromURL(url) : null;
  const filename = value.filename || fromURL?.filename;
  if (typeof filename !== 'string' || !filename || filename.length > 4096) return null;
  const kind = value.kind === 'video' || isVideoFile({ name: filename }) ? 'video' : 'image';
  return { filename, type: value.type || fromURL?.type || 'output', subfolder: value.subfolder || fromURL?.subfolder || '', kind, ...(value.root_id != null ? { root_id: value.root_id } : {}), ...(fromURL ? { url: fromURL.url } : {}) };
}
export function readCoverMedia(data) {
  for (const type of MEDIA_TYPES) {
    const raw = data.getData(type); if (!raw || raw.length > 1024 * 1024) continue;
    try { const value = JSON.parse(raw); const item = normalize(Array.isArray(value) ? value[0] : Array.isArray(value.items) ? value.items[0] : value); if (item) return item; } catch {}
  }
  for (const type of ['text/uri-list', 'text/plain']) for (const line of (data.getData(type) || '').split(/\r?\n/)) { const media = mediaFromURL(line.trim()); if (media) return media; }
  return null;
}
export function isCoverMediaDrag(data) {
  if (!data) return false;
  const types = [...data.types || []];
  if (MEDIA_TYPES.some(type => types.includes(type))) return true;
  if ([...data.items || []].some(item => item.kind === 'file' && /^(image|video)\//i.test(item.type)) || [...data.files || []].some(file => isImageFile(file) || isVideoFile(file))) return true;
  return types.includes('text/uri-list') && !types.includes('application/x-comfy-workflow') && !types.includes('application/x-codex-workflow-library');
}

export function sanitizeWorkflowSVG(source) {
  const parsedDocument = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = parsedDocument.documentElement;
  if (svg.localName !== 'svg' || parsedDocument.querySelector('parsererror')) throw new Error('工作流预览格式无效');
  for (const element of [...svg.querySelectorAll('script,foreignObject,iframe,object,embed,image,video,audio,use,style,animate,animateMotion,animateTransform,set')]) element.remove();
  for (const element of [svg, ...svg.querySelectorAll('*')]) for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase(), value = attribute.value;
    if (name.startsWith('on') || name === 'src' || name.endsWith('href') || name === 'style' || /url\(\s*(?!#)/i.test(value) || /javascript:/i.test(value)) element.removeAttribute(attribute.name);
  }
  svg.setAttribute('aria-label', '工作流节点预览');
  return document.importNode(svg, true);
}
