import { app } from '/scripts/app.js';

// V1.5.2 — local, user-initiated workflow library integration.
const LIBRARY = 'http://127.0.0.1:8190';
const INCOMING_MIME = 'application/x-codex-workflow-library';
const OUTGOING_MIME = 'application/x-comfy-workflow';
const MEDIA_MIME = 'application/x-codex-workflow-media';
const ASSET_MIMES = ['application/x-mjr-asset', 'application/x-mjr-assets', 'application/x-comfy-asset-info', 'application/x-mtb-asset', MEDIA_MIME];
const SNAPSHOT_VENDOR_URL = new URL('./vendor/html-to-image.min.js', import.meta.url).href;
const CLIENT_ID = `comfy-${crypto.randomUUID()}`;
const MAX_CACHE_ENTRIES = 12;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_STYLES = [
  'display', 'position', 'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'top', 'right', 'bottom', 'left', 'transform', 'transform-origin', 'z-index', 'opacity', 'visibility',
  'overflow', 'overflow-x', 'overflow-y', 'clip-path', 'contain',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'flex', 'flex-direction', 'flex-wrap', 'align-items', 'align-self', 'justify-content',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'gap',
  'color', 'background-color', 'background-image', 'background-size', 'background-position',
  'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-overflow', 'white-space', 'word-break', 'overflow-wrap',
  'object-fit', 'object-position', 'fill', 'stroke', 'stroke-width',
];
let token = null;
let stopped = false;
let timer = null;
let snapshotTimer = null;
let reconcileTimer = null;
let observer = null;
let unsubscribe = null;
let failures = 0;
let opening = Promise.resolve();
let captureInFlight = null;
let snapshotLibrary = null;
let sidebarRegistered = false;
let startingLibrary = null;
let libraryOverlay = null;
let libraryFrame = null;
let layoutObserver = null;
let libraryLayoutFrame = null;
let libraryGeneration = 0;
let libraryStartController = null;
const closingLibraries = new Map();
let libraryDragSession = null;
let libraryDropShield = null;
let libraryDragClickUntil = 0;
const requests = new Set();
const workflowCache = new Map();
const loadingCache = new Map();
let cacheBytes = 0;
const removers = [];

function relativePath(path) {
  return String(path || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/^workflows\//, '');
}

function store() {
  return app.extensionManager?.workflow;
}

function entries() {
  return store()?.workflows || store()?.openWorkflows || [];
}

function currentWorkflow() {
  return store()?.activeWorkflow || null;
}

function activePath() {
  const workflow = currentWorkflow();
  return workflow?.isTemporary ? null : relativePath(workflow?.path);
}

function listen(target, type, callback, options) {
  target.addEventListener(type, callback, options);
  removers.push(() => target.removeEventListener(type, callback, options));
}

async function request(path, data, { authenticate = true } = {}) {
  const controller = new AbortController();
  requests.add(controller);
  const deadline = setTimeout(() => controller.abort(), 6000);
  try {
    const headers = {};
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticate && token) headers['X-Library-Token'] = token;
    const response = await fetch(`${LIBRARY}${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) token = null;
      let message = `工作流库请求失败 (${response.status})`;
      try { message = (await response.json()).error || message; } catch { /* no JSON */ }
      throw new Error(message);
    }
    return await response.json();
  } finally {
    clearTimeout(deadline);
    requests.delete(controller);
  }
}

async function authorize() {
  if (!token) token = (await request('/api/bootstrap', undefined, { authenticate: false })).token;
  if (!token) throw new Error('工作流库未返回连接凭证');
}

function status(message, error = false) {
  const output = document.getElementById('codex-workflow-library-status');
  if (!output) return;
  output.textContent = message;
  output.style.color = error ? '#f0a090' : '#aaa';
  output.title = message;
}

async function performOpen(command) {
  const path = relativePath(command.path);
  if (!path || path.split('/').includes('..') || !path.toLowerCase().endsWith('.json')) {
    throw new Error('工作流路径无效');
  }
  const workflowStore = store();
  if (!workflowStore) throw new Error('ComfyUI 工作流管理器尚未就绪');
  if (relativePath(workflowStore.activeWorkflow?.path) === path) return { reused: true, path };

  // Refresh the native index only when the file is newly imported. Loading a graph
  // through the existing ComfyWorkflow preserves native tab identity and drafts.
  let workflow = workflowStore.getWorkflowByPath(`workflows/${path}`);
  if (!workflow) {
    await workflowStore.loadWorkflows?.();
    workflow = workflowStore.getWorkflowByPath(`workflows/${path}`);
  }
  if (!workflow) throw new Error('ComfyUI 尚未找到该工作流，请刷新工作流列表后重试');
  const wasLoaded = Boolean(workflow.isLoaded);
  await workflow.load();
  const savedState = workflow.activeState;
  if (!savedState) throw new Error('工作流内容为空');
  const loaded = await app.loadGraphData(
    JSON.parse(JSON.stringify(savedState)), true, true, workflow,
    { checkForRerouteMigration: false, deferWarnings: true, skipAssetScans: wasLoaded },
  );
  if (loaded === false || relativePath(currentWorkflow()?.path) !== path) {
    throw new Error('ComfyUI 未完成工作流切换');
  }
  window.focus();
  return { reused: wasLoaded, path };
}

function openWorkflow(command) {
  const result = opening.then(() => performOpen(command));
  opening = result.catch(() => undefined);
  return result;
}

async function poll() {
  if (stopped) return;
  try {
    await authorize();
    const result = await request('/api/bridge/poll', {
      clientId: CLIENT_ID,
      visible: !document.hidden,
      activePath: activePath(),
      openPaths: (store()?.openWorkflows || []).filter(w => !w.isTemporary).map(w => relativePath(w.path)),
    });
    failures = 0;
    status('已连接');
    if (result.command) {
      let success = false;
      let error = '';
      try {
        status('正在打开工作流…');
        await openWorkflow(result.command);
        success = true;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        status(error, true);
      }
      await request('/api/bridge/result', { jobId: result.command.jobId, success, error });
      if (success) status('已打开');
    }
  } catch {
    failures++;
    status('工作流库未启动');
  } finally {
    if (!stopped) timer = setTimeout(poll, failures ? Math.min(30000, 3000 * 2 ** Math.min(failures, 4)) : 3000);
  }
}

async function loadSnapshotLibrary() {
  if (window.htmlToImage?.toJpeg) return window.htmlToImage;
  if (!snapshotLibrary) snapshotLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SNAPSHOT_VENDOR_URL;
    const deadline = setTimeout(() => { script.remove(); reject(new Error('画布预览组件加载超时')); }, 6000);
    script.onload = () => {
      clearTimeout(deadline);
      if (window.htmlToImage?.toJpeg) resolve(window.htmlToImage);
      else reject(new Error('画布预览组件不可用'));
    };
    script.onerror = () => { clearTimeout(deadline); script.remove(); reject(new Error('画布预览组件加载失败')); };
    document.head.append(script);
  }).catch(error => { snapshotLibrary = null; throw error; });
  return snapshotLibrary;
}

function snapshotFilter(viewport, deadline) {
  const transform = viewport.querySelector('[data-testid="transform-pane"]');
  const graphLayers = [...viewport.children].filter(element => element.tagName === 'CANVAS' || element === transform || Boolean(transform && element.contains(transform)));
  const retained = new Set([viewport, ...graphLayers]);
  if (transform) {
    let ancestor = transform;
    while (ancestor && ancestor !== viewport) { retained.add(ancestor); ancestor = ancestor.parentElement; }
  }
  const bounds = viewport.getBoundingClientRect();
  const culled = new Set();
  for (const node of transform?.querySelectorAll('[data-node-id]') || []) {
    // Nested slots/widgets share the node id. Test the actual node boundary
    // once, before cloning, instead of repeatedly measuring every descendant.
    if (node.parentElement?.closest('[data-node-id]')) continue;
    const rect = node.getBoundingClientRect();
    const css = getComputedStyle(node);
    if (!rect.width || !rect.height || css.display === 'none' || css.visibility === 'hidden' ||
        rect.right <= bounds.left || rect.left >= bounds.right || rect.bottom <= bounds.top || rect.top >= bounds.bottom) culled.add(node);
  }
  return element => {
    if (performance.now() > deadline) throw new Error('画布预览超时，保留原预览');
    if (!(element instanceof Element)) return true;
    if (element === viewport) return true;
    if (element.hidden || element.style?.display === 'none' || element.style?.visibility === 'hidden' ||
        element.matches('dialog,input[type="password"],#codex-workflow-library-tools')) return false;
    const node = element.closest('[data-node-id]');
    if (node && (culled.has(node) || [...culled].some(root => root.contains(element)))) return false;
    // GraphCanvas also owns the entire splitter/toolbar/queue tree. Only the
    // graph canvas, Vue transform subtree and link overlay canvas are cloned.
    return retained.has(element) || graphLayers.some(layer => layer.contains(element));
  };
}

async function makeSnapshot(path) {
  if (!path || path !== activePath() || stopped) return false;
  await authorize();
  const source = app.canvas?.canvas;
  if (!source?.width || !source?.height) return false;
  const graph = app.rootGraph || app.graph;
  const graphId = graph?.id;
  let image;
  if (app.extensionManager?.setting?.get?.('Comfy.VueNodes.Enabled')) {
    // Vue nodes live outside the canvas. Capturing only that canvas would save
    // an empty grid, so clone the graph viewport including its live DOM layer.
    const viewport = document.getElementById('graph-canvas-container');
    if (!viewport?.querySelector('[data-node-id]') || !graph?._nodes?.length) return false;
    const library = await loadSnapshotLibrary();
    const width = viewport.clientWidth, height = viewport.clientHeight;
    if (!width || !height || path !== activePath() || graphId !== (app.rootGraph || app.graph)?.id) return false;
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const snapshotAbort = new AbortController();
    requests.add(snapshotAbort);
    const snapshotDeadline = performance.now() + 9500;
    const snapshotTimeout = setTimeout(() => snapshotAbort.abort(), 10000);
    try {
      image = await library.toJpeg(viewport, {
      width, height,
      canvasWidth: Math.max(1, Math.round(width * scale)),
      canvasHeight: Math.max(1, Math.round(height * scale)),
      pixelRatio: 1, quality: 0.83, backgroundColor: '#181818',
      skipFonts: true, cacheBust: false,
      includeStyleProperties: SNAPSHOT_STYLES,
      fetchRequestInit: { signal: snapshotAbort.signal },
      filter: snapshotFilter(viewport, snapshotDeadline),
      });
      if (snapshotAbort.signal.aborted || performance.now() > snapshotDeadline) return false;
    } finally {
      clearTimeout(snapshotTimeout);
      requests.delete(snapshotAbort);
    }
  } else {
  const scale = Math.min(1, 1600 / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#181818';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  try { image = canvas.toDataURL('image/jpeg', 0.83); } finally { canvas.width = canvas.height = 1; }
  }
  // A user may switch tabs during authorization or encoding. Never label the
  // new canvas as the old workflow's preview.
  if (path !== activePath() || graphId !== (app.rootGraph || app.graph)?.id || stopped) return false;
  await request('/api/snapshot', { path, image });
  return true;
}

function captureSnapshot(path = activePath()) {
  if (captureInFlight) return captureInFlight;
  captureInFlight = makeSnapshot(path).catch(error => {
    status('画布预览未更新，保留原预览', true);
    throw error;
  }).finally(() => { captureInFlight = null; });
  return captureInFlight;
}

function scheduleSnapshot(path) {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    captureSnapshot(path).catch(() => undefined);
  }, 350);
}

function cacheWorkflow(path, workflow) {
  const text = JSON.stringify(workflow);
  const bytes = new Blob([text]).size;
  if (bytes > MAX_CACHE_BYTES) return;
  if (workflowCache.has(path)) cacheBytes -= workflowCache.get(path).bytes;
  workflowCache.delete(path);
  workflowCache.set(path, { workflow, text, bytes });
  cacheBytes += bytes;
  while (workflowCache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const first = workflowCache.keys().next().value;
    cacheBytes -= workflowCache.get(first).bytes;
    workflowCache.delete(first);
  }
}

async function prefetch(path) {
  if (!path || workflowCache.has(path) || loadingCache.has(path) || loadingCache.size >= 2) return;
  const controller = new AbortController();
  requests.add(controller);
  const deadline = setTimeout(() => controller.abort(), 6000);
  const promise = (async () => {
    const response = await fetch(`/userdata/${encodeURIComponent(`workflows/${path}`)}`, { cache: 'no-cache', signal: controller.signal });
    if (!response.ok) return;
    const length = Number(response.headers.get('Content-Length') || 0);
    if (length > MAX_CACHE_BYTES) return;
    const text = await response.text();
    if (text.length > MAX_CACHE_BYTES) return;
    const workflow = JSON.parse(text);
    if (Array.isArray(workflow?.nodes)) cacheWorkflow(path, workflow);
  })().catch(() => undefined).finally(() => {
    clearTimeout(deadline);
    requests.delete(controller);
    loadingCache.delete(path);
  });
  loadingCache.set(path, promise);
  await promise;
}

function workflowForElement(target) {
  if (!(target instanceof Element)) return null;
  if (target.closest('.mjr-asset-card,#mtb-input-output-sidebar img,#mtb-input-output-sidebar video')) return null;
  if (target.closest('#codex-workflow-library-drag')) return currentWorkflow();
  const row = target.closest('.tree-explorer-item,[role="treeitem"]');
  const tree = target.closest('[data-testid^="tree-node-"]') || row?.querySelector('[data-testid^="tree-node-"]');
  if (tree) {
    const key = tree.getAttribute('data-testid').slice('tree-node-'.length);
    const path = relativePath(key.startsWith('root/') ? key.slice(5) : key);
    const resolved = store()?.getWorkflowByPath(`workflows/${path}`) || [...entries()].find(w => w.key === key || w.path === key);
    if (resolved) return resolved;
    // Tree keys may carry a rendering namespace. Resolve the actual workflow
    // object rather than constructing file paths from labels or folder keys.
    for (let component = tree.__vueParentComponent; component; component = component.parent) {
      const item = component.props?.node?.data || component.props?.workflowOption?.workflow;
      if (item?.path) {
        const actual = store()?.getWorkflowByPath(item.path);
        if (actual) return actual;
      }
    }
    try {
      const decoded = decodeURIComponent(key.startsWith('root/') ? key.slice(5) : key);
      return [...entries()].find(w => w.key === decoded || w.path === decoded || relativePath(w.path) === relativePath(decoded)) || null;
    } catch { return null; }
  }
  const tab = target.closest('[data-testid="workflow-tab"]');
  if (tab) {
    const tabs = [...document.querySelectorAll('[data-testid="workflow-tab"]')];
    return (store()?.openWorkflows || [])[tabs.indexOf(tab)] || null;
  }
  return null;
}

function mediaKind(filename, value) {
  const kind = String(value || '').toLowerCase();
  if (['image','video'].includes(kind)) return kind;
  if (/\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i.test(filename)) return 'image';
  if (/\.(mp4|mov|mkv|webm|avi|m4v|gifv)$/i.test(filename)) return 'video';
  return null;
}

function normalizeDraggedMedia(asset, sourceURL) {
  if (!asset || typeof asset !== 'object') asset = {};
  const info = asset.user_metadata && typeof asset.user_metadata === 'object' ? asset.user_metadata : {};
  let filename = String(asset.filename || info.filename || '').trim();
  let type = String(asset.type || info.type || '').toLowerCase();
  let subfolder = String(asset.subfolder ?? info.subfolder ?? '').replaceAll('\\','/');
  let url;
  for(const candidate of [sourceURL,asset.originalUrl,asset.original_url,asset.preview_url,asset.url]) {
    if(typeof candidate !== 'string' || !candidate) continue;
    try {
      const parsed = new URL(candidate,location.origin);
      if(parsed.protocol!=='http:' || !['127.0.0.1','localhost'].includes(parsed.hostname) || parsed.port!=='8000')continue;
      if(!['/view','/mtb/view','/mjr/am/custom-view'].includes(parsed.pathname))continue;
      url=parsed;
      if(!filename)filename=parsed.searchParams.get('filename')||'';
      if(!type)type=parsed.pathname==='/mjr/am/custom-view'?'custom':parsed.searchParams.get('type')||'';
      if(!subfolder)subfolder=parsed.searchParams.get('subfolder')||'';
      break;
    } catch { /* Ignore unrelated preview/download URLs. */ }
  }
  const kind = mediaKind(filename,asset.kind || asset.media_type);
  if(!kind || !filename || /[\\/\x00]/.test(filename) || subfolder.split('/').some(part=>part==='..'||part==='.') || subfolder.startsWith('/'))return null;
  if(type==='custom') {
    const root_id=String(asset.root_id || asset.rootId || url?.searchParams.get('root_id') || '').trim();
    if(!root_id)return null;
    // Preserve the source's declared custom root. The library backend decides
    // whether that root is available; never reinterpret it as native output.
    return {filename,type,subfolder,root_id,kind,...(url?{url:url.href}:{})};
  }
  if(!['input','output','temp'].includes(type))return null;
  const params = new URLSearchParams({filename,type,subfolder});
  return {filename,type,subfolder,kind,url:`${location.origin}/view?${params}`};
}

function mediaForDrag(event) {
  const transfer=event.dataTransfer;
  for(const mime of ASSET_MIMES) {
    try {
      const raw=transfer?.getData(mime);
      if(!raw || raw.length>131072)continue;
      const data=JSON.parse(raw);
      const candidate=Array.isArray(data)?data[0]:Array.isArray(data?.items)?data.items[0]:data;
      const media=normalizeDraggedMedia(candidate);
      if(media)return media;
    } catch { /* The source may not have populated its MIME data yet. */ }
  }
  const target=event.target instanceof Element?event.target:null;
  const card=target?.closest('.mjr-asset-card');
  if(card?._mjrAsset) {
    const media=normalizeDraggedMedia(card._mjrAsset);
    if(media)return media;
  }
  const uri=transfer?.getData('text/uri-list')?.split(/\r?\n/).find(line=>line&&!line.startsWith('#'));
  return uri?normalizeDraggedMedia({},uri):null;
}

function mediaDragStart(event) {
  if(!event.dataTransfer || !libraryOverlay)return;
  const media=mediaForDrag(event);
  if(!media)return;
  // Media is dropped directly onto the iframe card. A workflow-only parent
  // shield would cover that card and lose the selected cover target.
  clearLibraryDrag();
  event.dataTransfer.setData(MEDIA_MIME,JSON.stringify(media));
  if(media.url)event.dataTransfer.setData('text/uri-list',media.url);
  event.dataTransfer.effectAllowed='copyMove';
}

function dragStart(event) {
  if(mediaForDrag(event)) {mediaDragStart(event);return;}
  const workflow = workflowForElement(event.target);
  if (!workflow || !event.dataTransfer) return;
  const path = workflow.isTemporary ? null : relativePath(workflow.path);
  const name = workflow.filename || path?.split('/').at(-1)?.replace(/\.json$/i, '') || '未命名工作流';
  const cached = path ? workflowCache.get(path) : null;
  const payload = { path, name };
  if (!path) payload.workflow = JSON.parse(JSON.stringify(workflow.activeState || app.rootGraph?.serialize() || app.graph.serialize()));
  else if (cached) payload.workflow = cached.workflow;
  event.dataTransfer.setData(OUTGOING_MIME, JSON.stringify(payload));
  if (libraryOverlay) startLibraryDrag(payload);
  if (path) {
    const reference = { type: 'comfy-workflow-reference', version: 1, path, name };
    const text = JSON.stringify(reference);
    event.dataTransfer.setData('text/plain', text);
    event.dataTransfer.setData('text/uri-list', `${LIBRARY}/#workflow-reference=${encodeURIComponent(text)}`);
  }
  if (cached || payload.workflow) {
    const text = cached?.text || JSON.stringify(payload.workflow);
    if (!path) event.dataTransfer.setData('text/plain', text);
    try {
      event.dataTransfer.items.add(new File([text], `${name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.json$/i, '')}.json`, { type: 'application/json' }));
    } catch { /* Custom workflow MIME remains available across browser windows. */ }
  }
  event.dataTransfer.effectAllowed = event.target.closest?.('#codex-workflow-library-drag') ? 'copy' : 'copyMove';
  // Only the explicit drag handle captures a screenshot: native tab/sidebar
  // reorders should not create library metadata as a side effect.
  if (event.target.closest?.('#codex-workflow-library-drag') && path) scheduleSnapshot(path);
}

function isLibraryDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes(INCOMING_MIME);
}

function dragOver(event) {
  if (!isLibraryDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}

async function drop(event) {
  if (!isLibraryDrag(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    const raw = event.dataTransfer.getData(INCOMING_MIME);
    if (raw.length > 8192) throw new Error('工作流拖拽数据过大');
    const payload = JSON.parse(raw);
    if (!payload.path && !payload.id) throw new Error('工作流拖拽数据无效');
    await authorize();
    let command = payload;
    if (payload.id) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(payload.id)) throw new Error('工作流标识无效');
      const bootstrap = await request('/api/bootstrap');
      const entry = bootstrap.workflows.find(item => item.id === payload.id);
      if (!entry) throw new Error('该工作流已不在工作流库中');
      command = { ...payload, path: entry.path };
    }
    status('正在打开工作流…');
    await openWorkflow(command);
    await request('/api/snapshot', { path: relativePath(command.path) });
    status('已打开');
  } catch (failure) {
    status(failure instanceof Error ? failure.message : String(failure), true);
  }
}

function reconcile() {
  if (stopped) return;
  for (const element of document.querySelectorAll('[data-testid^="tree-node-"]')) {
    if (!workflowForElement(element)) continue;
    const handle = element.closest('.tree-explorer-item') || element;
    if (handle.getAttribute('draggable') !== 'true') handle.draggable = true;
  }
  const ownButton = document.querySelector('[data-testid="codex-workflow-library-tab-button"]');
  const group = document.querySelector('[data-testid="sidebar-top-group"]');
  const templates = group?.querySelector('.templates-tab-button');
  if (ownButton && group && templates) {
    let templateItem = templates;
    while (templateItem.parentElement && templateItem.parentElement !== group) templateItem = templateItem.parentElement;
    const assets = group.querySelector('[data-testid="bbaigc-asset-library-tab-button"]');
    // Both libraries share this slot: keep one stable order without competing observers.
    if (assets?.parentElement === group && templateItem.nextElementSibling !== assets) templateItem.after(assets);
    const anchor = assets?.parentElement === group ? assets : templateItem;
    if (ownButton.parentElement === group && anchor.nextElementSibling !== ownButton) anchor.after(ownButton);
    ownButton.setAttribute('aria-label', '工作流库');
    ownButton.title = '工作流库';
  }
  scheduleLibraryLayout();
}

function postLibrary(type, extra = {}) {
  libraryFrame?.contentWindow?.postMessage({ channel: 'codex-workflow-library', type, ...extra }, LIBRARY);
}

function clearLibraryDrag() {
  libraryDropShield?.remove();libraryDropShield = null;libraryDragSession = null;
}

function startLibraryDrag(payload, pointer) {
  if (!libraryOverlay || (!payload.path && !payload.workflow)) return;
  // Keep a verified local reference in the parent document. DataTransfer MIME
  // formats may be consumed by native tree DnD before reaching a child frame.
  libraryDragSession = { payload: payload.path ? {path:payload.path,name:payload.name} : payload, pointer, moved:!pointer, sent:false };
  if (!pointer) showLibraryDropShield();
}

function showLibraryDropShield() {
  if (!libraryOverlay || libraryDropShield || !libraryDragSession) return;
  const shield = document.createElement('div');
  shield.id = 'codex-workflow-library-drop-shield';
  shield.style.cssText = 'position:absolute;inset:0;z-index:20;background:rgba(95,125,215,.07);outline:2px solid #7895d1;outline-offset:-2px;pointer-events:auto';
  shield.setAttribute('aria-label','放入工作流库');
  shield.addEventListener('dragenter', event => {event.preventDefault();event.stopImmediatePropagation();});
  shield.addEventListener('dragover', event => {event.preventDefault();event.stopImmediatePropagation();event.dataTransfer.dropEffect='copy';});
  shield.addEventListener('drop', event => {event.preventDefault();event.stopImmediatePropagation();finishLibraryDrag();});
  libraryOverlay.append(shield);libraryDropShield=shield;
}

function finishLibraryDrag() {
  const session=libraryDragSession;
  if (!session || session.sent || !session.moved || !libraryOverlay) return;
  session.sent=true;libraryDragClickUntil=Date.now()+350;
  postLibrary('workflow-drag',{payload:session.payload});clearLibraryDrag();
}

function libraryPointerDown(event) {
  if (!libraryOverlay || event.button!==0) return;
  if(event.target instanceof Element && event.target.closest('.mjr-asset-card')) {clearLibraryDrag();return;}
  const workflow=workflowForElement(event.target);
  if (!workflow) return;
  const path=workflow.isTemporary?null:relativePath(workflow.path);
  const payload={path,name:workflow.filename||path?.split('/').at(-1)||'未命名工作流'};
  if (!path) payload.workflow=JSON.parse(JSON.stringify(workflow.activeState||app.rootGraph?.serialize()||app.graph.serialize()));
  startLibraryDrag(payload,{x:event.clientX,y:event.clientY});
}

function libraryPointerMove(event) {
  const session=libraryDragSession;
  if (!session?.pointer || !libraryOverlay || !event.buttons) return;
  if (Math.hypot(event.clientX-session.pointer.x,event.clientY-session.pointer.y)<6) return;
  session.moved=true;
  const bounds=libraryOverlay.getBoundingClientRect();
  if(event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom)showLibraryDropShield();
}

function libraryPointerUp(event) {
  if (!libraryDragSession) return;
  const bounds=libraryOverlay?.getBoundingClientRect();
  if(libraryDropShield&&bounds&&event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom){event.preventDefault();event.stopImmediatePropagation();finishLibraryDrag();}
  else clearLibraryDrag();
}

function libraryBounds() {
  const bounds = {left:0,top:0,right:window.innerWidth,bottom:window.innerHeight};
  // Measure only visible native rails and the expanded workflow sidebar. The
  // graph panel adds an eight-pixel gutter and its top moves when the queue
  // expands, so none of its geometry defines the embedded workspace.
  for(const element of document.querySelectorAll('[data-testid="side-toolbar"],.sidebar-content-container')){
    const item=element.getBoundingClientRect();
    if(item.width&&item.height&&item.left<window.innerWidth*.5)bounds.left=Math.max(bounds.left,item.right);
  }
  // TopMenuSection also owns queue/error overlays. Restrict the measurement
  // to actual actionbar surfaces so those floating panels are covered by the
  // library while the entire run/CPU/memory/temperature row stays accessible.
  for(const element of document.querySelectorAll('[data-testid="top-menu-actionbars"],[data-testid="action-bar-card"],.actionbar-container,[data-testid="legacy-topbar-container"],.comfy-menu,[data-testid="topbar-workflow-tabs"],.workflow-tabs-container')){
    const item=element.getBoundingClientRect();
    if(item.width&&item.height&&item.top>=0&&item.top<window.innerHeight*.3&&item.height<150)bounds.top=Math.max(bounds.top,item.bottom);
  }
  return {left:Math.max(0,bounds.left),top:Math.max(0,bounds.top),width:Math.max(0,bounds.right-bounds.left),height:Math.max(0,bounds.bottom-bounds.top)};
}

function updateLibraryLayout() {
  if (!libraryOverlay) return;
  const bounds = libraryBounds();
  for (const key of ['left', 'top', 'width', 'height']) {
    const value = `${Math.round(bounds[key])}px`;
    if (libraryOverlay.style[key] !== value) libraryOverlay.style[key] = value;
  }
}

function scheduleLibraryLayout() {
  if (!libraryOverlay || libraryLayoutFrame) return;
  libraryLayoutFrame = requestAnimationFrame(() => { libraryLayoutFrame = null; updateLibraryLayout(); });
}

function reducedLibraryMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function closeLibrary({ immediate = false } = {}) {
  libraryGeneration++;
  clearLibraryDrag();
  libraryStartController?.abort();libraryStartController = null;startingLibrary = null;
  if (libraryLayoutFrame) cancelAnimationFrame(libraryLayoutFrame);
  libraryLayoutFrame = null;
  layoutObserver?.disconnect();layoutObserver = null;
  const overlay = libraryOverlay;
  libraryOverlay = null;libraryFrame = null;
  if (overlay) {
    // Detached references own the exit lifecycle: an old close callback must
    // never clear a newly opened frame or cancel its pending launch.
    overlay.style.pointerEvents = 'none';
    for (const element of [overlay, ...overlay.querySelectorAll('[id]')]) element.id = `${element.id}-closing-${libraryGeneration}`;
    if (immediate || stopped || reducedLibraryMotion()) overlay.remove();
    else {
      overlay.style.transitionDuration = '135ms';
      overlay.style.opacity = '0';
      overlay.style.transform = 'none';
      const timeout = setTimeout(() => { overlay.remove();closingLibraries.delete(overlay); }, 145);
      closingLibraries.set(overlay, timeout);
    }
  }
  const button = document.querySelector('[data-testid="codex-workflow-library-tab-button"]');
  button?.classList.remove('side-bar-button-selected');button?.setAttribute('aria-expanded', 'false');
  const tools = document.getElementById('codex-workflow-library-tools');if (tools) tools.hidden = false;
}

function mountLibrary() {
  const overlay = document.createElement('section');
  overlay.id = 'codex-workflow-library-overlay';overlay.setAttribute('aria-label', '工作流库');
  overlay.style.cssText = 'position:fixed;z-index:1300;background:#181818;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;opacity:0;transform:none;transition:opacity 180ms ease';
  const header = document.createElement('div');
  header.id = 'codex-workflow-library-loading-header';
  header.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;height:30px;min-height:30px;padding:0 10px;border-bottom:1px solid #363636;background:#1d1d1d';
  const close = document.createElement('button');
  close.type = 'button';close.textContent = '关闭';close.title = '关闭工作流库，返回画布';close.setAttribute('aria-label', close.title);
  close.style.cssText = 'border:0;background:transparent;color:#ccc;font:12px system-ui;cursor:pointer;padding:4px 8px';
  close.onclick = closeLibrary;header.append(close);
  const loading = document.createElement('div');
  loading.id = 'codex-workflow-library-loading';loading.textContent = '正在打开工作流库…';loading.setAttribute('role', 'status');
  loading.style.cssText = 'position:absolute;inset:30px 0 0;display:flex;align-items:center;justify-content:center;color:#aaa;font:14px system-ui';
  const frame = document.createElement('iframe');
  frame.id = 'codex-workflow-library-frame';frame.title = '工作流库';
  frame.style.cssText = 'border:0;display:block;width:100%;flex:1;min-height:0;visibility:hidden;background:#181818';
  overlay.append(header, loading, frame);document.body.append(overlay);
  libraryOverlay = overlay;libraryFrame = frame;
  if (reducedLibraryMotion()) {
    overlay.style.transition = 'none';overlay.style.opacity = '1';overlay.style.transform = 'none';
  } else {
    // Commit the initial style before scheduling the entry transition.
    overlay.getBoundingClientRect();
    requestAnimationFrame(() => { if (libraryOverlay === overlay) {overlay.style.opacity = '1';overlay.style.transform = 'none';} });
  }
  const tools = document.getElementById('codex-workflow-library-tools');if (tools) tools.hidden = true;
  const button = document.querySelector('[data-testid="codex-workflow-library-tab-button"]');
  button?.classList.add('side-bar-button-selected');button?.setAttribute('aria-expanded', 'true');
  updateLibraryLayout();layoutObserver = new ResizeObserver(scheduleLibraryLayout);
  for (const element of document.querySelectorAll('#graph-canvas-panel,#main-panel,[data-testid="side-toolbar"],.workflow-tabs-container')) layoutObserver.observe(element);
  header.addEventListener('dragover', event => {
    if ([...event.dataTransfer.types].some(type => [OUTGOING_MIME, 'text/plain'].includes(type))) {event.preventDefault();event.dataTransfer.dropEffect = 'copy';}
  });
  header.addEventListener('drop', event => {
    try {
      const payload = JSON.parse(event.dataTransfer.getData(OUTGOING_MIME) || event.dataTransfer.getData('text/plain'));
      if (payload.path || payload.workflow) {event.preventDefault();event.stopPropagation();postLibrary('workflow-drag', {payload});}
    } catch { /* Other native drags retain their own behavior. */ }
  });
  return { overlay, frame, loading };
}

async function libraryMessage(event) {
  if (!libraryFrame || event.origin !== LIBRARY || event.source !== libraryFrame.contentWindow || event.data?.channel !== 'codex-workflow-library') return;
  const message = event.data;
  if (message.type === 'ready') {
    libraryFrame.style.visibility = 'visible';document.getElementById('codex-workflow-library-loading')?.remove();
    const header = document.getElementById('codex-workflow-library-loading-header');
    if (header) header.style.display = 'none';
    postLibrary('host-ready', {version:'1.5.2',clientId:CLIENT_ID});return;
  }
  if (message.type === 'close') {closeLibrary();return;}
  if (message.type !== 'open') return;
  const frame = libraryFrame;
  try {
    let path = message.path;
    if (message.id) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(message.id)) throw new Error('工作流标识无效');
      const bootstrap = await request('/api/bootstrap');path = bootstrap.workflows.find(item => item.id === message.id)?.path;
      if (!path) throw new Error('该工作流已不在工作流库中');
    }
    if (frame !== libraryFrame) return;
    await openWorkflow({path});
    if (frame !== libraryFrame) return;
    postLibrary('opened', {id:message.id,path:relativePath(path)});closeLibrary();status('已打开工作流');
  } catch (error) {
    if (frame === libraryFrame) postLibrary('error', {id:message.id,message:error instanceof Error ? error.message : String(error)});
  }
}

function openLibrary() {
  if (libraryOverlay) {closeLibrary();return Promise.resolve(false);}
  if (startingLibrary) return startingLibrary;
  const generation = ++libraryGeneration;
  const {overlay,frame,loading} = mountLibrary();
  const launch = (async () => {
    const controller = new AbortController();requests.add(controller);
    libraryStartController = controller;
    const deadline = setTimeout(() => controller.abort(), 20000);
    try {
      status('正在打开工作流库…');
      const response = await fetch('/workflow-library/start', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:controller.signal,credentials:'same-origin',cache:'no-store'});
      if (controller.signal.aborted || generation !== libraryGeneration) return false;
      if (!response.ok) {
        const running = await request('/api/bootstrap', undefined, {authenticate:false});
        if (running.service && running.service !== 'comfy-workflow-library') throw new Error('工作流库服务未就绪');
      } else {
        const result = await response.json();if (result.error) throw new Error(result.error || '工作流库启动失败');
      }
      if (generation !== libraryGeneration || overlay !== libraryOverlay) return false;
      frame.src = `${LIBRARY}/?embedded=1`;status('已打开工作流库');return true;
    } catch (error) {
      if (controller.signal.aborted || generation !== libraryGeneration) return false;
      if (overlay === libraryOverlay) {loading.textContent='工作流库未能启动，请点击左侧图标关闭后重试。';loading.style.color='#e8aaa0';}
      status('工作流库未能启动，请双击“启动工作流库”',true);return false;
    } finally {clearTimeout(deadline);requests.delete(controller);if(libraryStartController===controller)libraryStartController=null;}
  })().finally(() => {if(startingLibrary===launch)startingLibrary=null;});
  startingLibrary = launch;
  return startingLibrary;
}

function installSidebar() {
  const sheet = document.createElement('style');
  sheet.id = 'codex-workflow-library-icon-style';
  const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="10" width="7" height="5" rx="1"/><rect x="3" y="17" width="7" height="5" rx="1"/><path d="M6.5 8v4.5H14M6.5 17v-4.5"/></g></svg>';
  const data = `url("data:image/svg+xml,${encodeURIComponent(icon)}")`;
  sheet.textContent = `.codex-workflow-library-icon{display:inline-block;width:20px;height:20px;background:currentColor;mask:${data} center/contain no-repeat;-webkit-mask:${data} center/contain no-repeat}`;
  document.head.append(sheet);
  removers.push(() => sheet.remove());
  const manager = app.extensionManager;
  if (!manager?.registerSidebarTab) return;
  manager.unregisterSidebarTab?.('codex-workflow-library');
  manager.registerSidebarTab({
    id: 'codex-workflow-library', title: '工作流库', label: '工作流库', tooltip: '工作流库',
    icon: 'codex-workflow-library-icon', type: 'custom',
    render: element => { element.textContent = ''; },
    onToggle: () => { void openLibrary(); return true; },
  });
  sidebarRegistered = true;
}

function installToolbar() {
  const root = document.createElement('div');
  root.id = 'codex-workflow-library-tools';
  root.style.cssText = 'position:fixed;right:20px;bottom:56px;z-index:120;display:flex;gap:8px;align-items:center;padding:5px 8px;background:var(--comfy-menu-bg,#202020);border:1px solid var(--border-color,#444);border-radius:5px;color:var(--input-text,#eee);font:12px sans-serif;max-width:min(410px,calc(100vw - 40px))';
  const drag = document.createElement('button');
  drag.type = 'button';
  drag.id = 'codex-workflow-library-drag';
  drag.textContent = '拖出工作流';
  drag.title = '将当前工作流拖到工作流库；也可直接拖左侧文件或顶部标签';
  drag.draggable = true;
  drag.style.cssText = 'background:transparent;color:inherit;border:1px solid var(--border-color,#444);border-radius:3px;cursor:grab;padding:3px 5px;font:inherit;white-space:nowrap';
  drag.onclick = () => captureSnapshot().then(done => status(done ? '预览已更新' : '请先保存当前工作流')).catch(() => status('工作流库未启动', true));
  const output = document.createElement('span');
  output.id = 'codex-workflow-library-status';
  output.setAttribute('role', 'status');
  output.style.cssText = 'color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px';
  output.textContent = '正在连接…';
  root.append(drag, output);
  document.body.append(root);
  removers.push(() => root.remove());
}

function stop() {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(snapshotTimer);
  clearTimeout(reconcileTimer);
  observer?.disconnect();
  unsubscribe?.();
  closeLibrary();
  for (const [overlay, timeout] of closingLibraries) {clearTimeout(timeout);overlay.remove();}
  closingLibraries.clear();
  if (sidebarRegistered) app.extensionManager?.unregisterSidebarTab?.('codex-workflow-library');
  sidebarRegistered = false;
  for (const remove of removers.splice(0)) remove();
  for (const controller of requests) controller.abort();
  workflowCache.clear();
  cacheBytes = 0;
}

if (!app.extensions.some(extension => extension.name === 'Codex.WorkflowLibrary')) app.registerExtension({
  name: 'Codex.WorkflowLibrary',
  async setup() {
    window.__codexWorkflowLibrary?.stop?.();
    stopped = false;
    installSidebar();
    installToolbar();
    listen(window, 'message', libraryMessage);
    listen(window, 'pointerdown', libraryPointerDown, true);
    listen(window, 'pointermove', libraryPointerMove, true);
    listen(window, 'pointerup', libraryPointerUp, true);
    listen(window, 'dragend', clearLibraryDrag, true);
    listen(window, 'click', event => {if(Date.now()<libraryDragClickUntil){event.preventDefault();event.stopImmediatePropagation();}}, true);
    listen(window, 'resize', scheduleLibraryLayout, { passive: true });
    listen(window, 'dragstart', dragStart, true);
    // Pragmatic DnD writes its native formats during bubbling. Add the OS-safe
    // reference after it too, without stopping its internal move/reorder events.
    listen(document, 'dragstart', dragStart, false);
    // Majoor fills its asset payload in container capture, MTB on the target.
    // Normalize once more during bubbling after those native handlers finish.
    listen(document, 'dragstart', mediaDragStart, false);
    listen(document, 'dragover', dragOver, true);
    listen(window, 'drop', drop, true);
    listen(document, 'pointerover', event => {
      const workflow = workflowForElement(event.target);
      if (workflow && !workflow.isTemporary) void prefetch(relativePath(workflow.path));
    }, { passive: true });
    listen(window, 'pagehide', stop, { once: true });
    const workflowStore = store();
    unsubscribe = workflowStore?.$onAction(({ name, args, after }) => {
      if (!['saveWorkflow', 'saveAs'].includes(name)) return;
      const workflow = args?.[0];
      after(result => {
        const savedWorkflow = result?.path ? result : workflow;
        const path = relativePath(savedWorkflow?.path || currentWorkflow()?.path);
        if (path && !savedWorkflow?.isTemporary) {
          cacheBytes -= workflowCache.get(path)?.bytes || 0;
          workflowCache.delete(path);
          scheduleSnapshot(path);
        }
      });
    }, true);
    observer = new MutationObserver(() => {
      if (reconcileTimer) return;
      reconcileTimer = setTimeout(() => { reconcileTimer = null; reconcile(); }, 750);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    reconcile();
    window.__codexWorkflowLibrary = { version: '1.5.2', open: openWorkflow, openLibrary, closeLibrary, captureSnapshot, relativePath, stop, get clientId() { return CLIENT_ID; } };
    void poll();
  },
});
