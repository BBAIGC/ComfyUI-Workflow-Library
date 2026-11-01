import { readWorkflowReference } from './workflow-drag.js';
import { MEDIA_TYPES, readCoverMedia, isCoverMediaDrag, isVideoFile, isImageFile, sanitizeWorkflowSVG } from './cover-media.js';
import { CoverVideoPool } from './cover-video.js';
import { renderTextCover, animateTextCover } from './text-cover.js';
const $ = (id) => document.getElementById(id);
const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
const hostOrigins = ['http://127.0.0.1:8000', 'http://localhost:8000'];
let hostOrigin = null, hostReady = false, readyTimer = null;
const hostOpenings = new Map();
const cardClickTimers = new Map();
const state = { token: '', version: '', categories: [], workflows: [], category: 'all', search: '', sort: 'modified', comfy: {}, preview: null, previewMode: 'graph', editing: null, coverTarget: null, selected: null, selection: new Set(), anchor: null, clipboardIds: [], coverMode: 'workflow', fillCovers: false, playDynamic: true, generation: 0, loading: false };
const videoPool = new CoverVideoPool();
const textRenderers = [];
const pendingTextIds = new Set();
let textCoverTarget = null, textCoverGeneration = 0, textModalRenderer = null, removeIds = [];
const textCoverEdits = { title: 0, subtitle: 0 };
let previewRequest = null, previewDimensions = null, sizeFrame = null, sizePersistTimer = null, sizeDragging = false, sizeTarget = 440;
const graphCache = new Map();
const pendingGraphs = new Map();
const activeRequests = new Set();
const jobs = new Set();
let pollTimer, searchTimer, dragDepth = 0, previewGeneration = 0, graphCacheBytes = 0, shuttingDown = false;
let zoom = { scale: 1, fit: 1, x: 0, y: 0, pointer: null };
const categoryIcons = {
  all: '<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/>',
  img: '<rect x="2.5" y="3" width="15" height="14" rx="2"/><circle cx="7" cy="7.5" r="1.5"/><path d="m3 14 4-4 3 3 3-4 4 5"/>',
  video: '<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="m8 7 5 3-5 3z"/>',
  upscale: '<path d="M12 3h5v5M17 3l-6 6M8 17H3v-5M3 17l6-6"/>',
  other: '<path d="M2.5 6h6l2-2h7v12h-15z"/>'
};

async function request(path, options = {}) {
  const controller = new AbortController();
  activeRequests.add(controller);
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 20000);
  try {
    const headers = { ...options.headers };
    if (options.body !== undefined && options.rawBody === undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers['X-Library-Token'] = state.token;
    const response = await fetch(path, { ...options, headers, body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)), signal: controller.signal });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error('服务器返回了无法读取的数据'); }
    if (!response.ok) throw new Error(payload.error || payload.message || `请求失败（${response.status}）`);
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请检查本地服务后重试');
    if (error instanceof TypeError) throw new Error('无法连接工作流库，请重新启动本地服务');
    throw error;
  } finally { clearTimeout(timer); activeRequests.delete(controller); }
}

function toast(message, kind = '', persistent = false) {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  const marker = document.createElement('span');
  marker.className = kind === 'pending' ? 'spinner' : '';
  marker.textContent = kind === 'success' ? '✓' : kind === 'error' ? '!' : '';
  const text = document.createElement('span');
  text.className = 'toast-text'; text.textContent = message;
  const close = document.createElement('button');
  close.className = 'toast-close'; close.textContent = '×'; close.setAttribute('aria-label', '关闭通知');
  close.onclick = () => element.remove();
  element.append(marker, text, close); $('toast-area').append(element);
  while ($('toast-area').children.length > 5) $('toast-area').firstElementChild.remove();
  let timer;
  if (!persistent) timer = setTimeout(() => element.remove(), kind === 'error' ? 9000 : 4200);
  return { update(message, kind = '') { clearTimeout(timer); text.textContent = message; element.className = `toast ${kind}`; marker.className = kind === 'pending' ? 'spinner' : ''; marker.textContent = kind === 'success' ? '✓' : kind === 'error' ? '!' : ''; if (kind !== 'pending') timer = setTimeout(() => element.remove(), kind === 'error' ? 10000 : 5000); }, remove() { clearTimeout(timer); element.remove(); } };
}

function timeValue(value) { if (!value) return 0; if (typeof value === 'number') return value < 1e12 ? value * 1000 : value; return new Date(value).getTime() || 0; }
function dateText(value, detail = false) {
  const timestamp = timeValue(value);
  if (!timestamp) return '尚未使用';
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', detail ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function workflowById(id) { return state.workflows.find((item) => String(item.id) === String(id)); }
function categoryName(id) { return state.categories.find((item) => item.id === id)?.name || '未分类'; }
function displayName(item) { return item.name || item.path?.split(/[\\/]/).pop()?.replace(/\.json$/i, '') || '未命名工作流'; }
function categoryIds(item) { return Array.isArray(item.categoryIds) ? item.categoryIds : [item.category]; }
function selectedItems() { return filteredWorkflows().filter(item => state.selection.has(String(item.id))); }
function updateSelectionUI() {
  const items = selectedItems(), count = items.length;
  if (!items.some(item => String(item.id) === String(state.selected))) state.selected = items.at(-1)?.id ?? null;
  for (const card of $('gallery').querySelectorAll('.workflow-card')) { const selected = state.selection.has(card.dataset.id); card.classList.toggle('selected', selected); card.setAttribute('aria-selected', String(selected)); }
  $('selection-name').textContent = count ? `已选 ${count} 项` : '未选中';
  $('selection-name').title = items.map(displayName).join('\n');
  for (const id of ['copy-selected', 'selected-text-cover', 'selected-remove']) $(id).disabled = !count;
  for (const id of ['selected-preview', 'selected-cover', 'selected-edit']) $(id).disabled = count !== 1;
  $('paste-selected').disabled = !state.clipboardIds.length || state.category === 'all';
  $('paste-selected').title = state.category === 'all' ? '选择分类后粘贴' : '粘贴到当前分类';
  $('select-all').disabled = !filteredWorkflows().length;
}
function selectWorkflow(item, event = {}) {
  if (!item) { state.selection.clear(); state.selected = null; state.anchor = null; updateSelectionUI(); return; }
  const id = String(item.id), ids = filteredWorkflows().map(item => String(item.id));
  if (event.shiftKey && state.anchor && ids.includes(state.anchor)) {
    const begin = ids.indexOf(state.anchor), end = ids.indexOf(id);
    if (!event.ctrlKey && !event.metaKey) state.selection.clear();
    for (const member of ids.slice(Math.min(begin, end), Math.max(begin, end) + 1)) state.selection.add(member);
  } else if (event.ctrlKey || event.metaKey) {
    if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
    state.anchor = id;
  } else {
    state.selection.clear(); state.selection.add(id); state.anchor = id;
  }
  state.selected = item.id; updateSelectionUI();
}
function contextSelect(item) { if (!state.selection.has(String(item.id))) selectWorkflow(item); else { state.selected = item.id; updateSelectionUI(); } }
function selectAllVisible() { state.selection = new Set(filteredWorkflows().map(item => String(item.id))); state.selected = filteredWorkflows().at(-1)?.id ?? null; state.anchor = filteredWorkflows()[0]?.id ? String(filteredWorkflows()[0].id) : null; updateSelectionUI(); }
function updateCoverMode(mode, save = true) {
  state.coverMode = ['custom', 'workflow', 'text'].includes(mode) ? mode : 'custom';
  const index = ['custom', 'workflow', 'text'].indexOf(state.coverMode);
  $('cover-mode').style.setProperty('--mode-index', String(index));
  for (const button of $('cover-mode').querySelectorAll('[data-cover-mode]')) button.setAttribute('aria-pressed', String(button.dataset.coverMode === state.coverMode));
  $('gallery').classList.toggle('show-original', state.coverMode === 'workflow');
  $('gallery').classList.toggle('text-cover-mode', state.coverMode === 'text');
  for (const cover of $('gallery').querySelectorAll('.card-text-cover')) cover.setAttribute('aria-hidden', String(state.coverMode !== 'text'));
  syncCoverPlayback();
  if (save) try { localStorage.setItem('workflow-library-cover-mode', state.coverMode); } catch {}
}
function syncCoverPlayback() { videoPool.setEnabled(state.coverMode === 'custom' && state.playDynamic && !document.hidden && !$('preview-dialog').open); }
function updateCoverOptions(save = true) {
  $('fill-covers').setAttribute('aria-checked', String(state.fillCovers));
  $('play-dynamic').setAttribute('aria-checked', String(state.playDynamic));
  $('play-dynamic').hidden = state.category !== 'video';
  $('gallery').classList.toggle('fill-covers', state.fillCovers);
  if (save) try { localStorage.setItem('workflow-library-fill-covers', String(state.fillCovers)); localStorage.setItem('workflow-library-play-dynamic', String(state.playDynamic)); } catch {}
  syncCoverPlayback();
}
function chooseCover(item) { state.coverTarget = item; $('cover-file').value = ''; $('cover-file').click(); }
function postHost(type, payload = {}) {
  if (!embedded) return;
  const message = { channel: 'codex-workflow-library', type, ...payload };
  for (const origin of hostOrigin ? [hostOrigin] : hostOrigins) window.parent.postMessage(message, origin);
}
function clearCardClick(id) { clearTimeout(cardClickTimers.get(id)); cardClickTimers.delete(id); }
function openInHost(item) {
  if (!hostReady) { toast('正在连接画布，请稍后重试', 'error'); postHost('ready'); return; }
  if (hostOpenings.has(String(item.id))) return;
  clearCardClick(item.id);
  if ($('preview-dialog').open) closePreview();
  const notice = toast(`正在打开「${displayName(item)}」`, 'pending', true);
  const timeout = setTimeout(() => { hostOpenings.delete(String(item.id)); notice.update('工作流尚未打开，请重试', 'error'); }, 60000);
  hostOpenings.set(String(item.id), { notice, timeout });
  postHost('open', { id: item.id, path: item.path });
}
function icon(type) { const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); element.setAttribute('viewBox', '0 0 20 20'); element.setAttribute('aria-hidden', 'true'); element.innerHTML = categoryIcons[type] || categoryIcons.other; return element; }

function renderCategories() {
  const fragment = document.createDocumentFragment();
  for (const category of [{ id: 'all', name: '全部工作流' }, ...state.categories]) {
    const button = document.createElement('button');
    button.className = `category-button${state.category === category.id ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(state.category === category.id));
    const name = document.createElement('span'); name.className = 'category-name'; name.textContent = category.name;
    const count = document.createElement('span'); count.className = 'category-count'; count.textContent = category.id === 'all' ? state.workflows.length : state.workflows.filter((item) => categoryIds(item).includes(category.id)).length;
    button.append(icon(category.id), name, count);
    button.onclick = () => { state.category = category.id; renderCategories(); renderGallery(); };
    fragment.append(button);
  }
  $('category-nav').replaceChildren(fragment);
}

function updateConnection() {
  const connected = Boolean(state.comfy.online);
  const bridged = Boolean(state.comfy.bridge);
  $('connection').className = `connection${connected ? bridged ? ' online' : ' partial' : ''}`;
  $('connection').lastElementChild.textContent = connected ? bridged ? 'ComfyUI 已连接' : 'ComfyUI 运行中' : 'ComfyUI 未启动';
  $('connection').title = connected && !bridged ? '打开 ComfyUI 页面后可连接工作流库' : connected ? '可直接打开工作流' : '打开工作流时将启动 ComfyUI';
}

function filteredWorkflows() {
  const query = state.search.toLocaleLowerCase();
  return state.workflows.filter((item) => (state.category === 'all' || categoryIds(item).includes(state.category)) && (!query || `${displayName(item)} ${item.path || ''}`.toLocaleLowerCase().includes(query))).sort((a, b) => {
    if (state.sort === 'name') return displayName(a).localeCompare(displayName(b), 'zh-CN', { numeric: true });
    return timeValue(b[state.sort]) - timeValue(a[state.sort]) || displayName(a).localeCompare(displayName(b), 'zh-CN', { numeric: true });
  });
}

function renderGallery() {
  videoPool.clear();
  for (const renderer of textRenderers.splice(0)) renderer?.dispose?.();
  const items = filteredWorkflows();
  const visibleIds = new Set(items.map(item => String(item.id)));
  state.selection = new Set([...state.selection].filter(id => visibleIds.has(id)));
  $('page-title').textContent = state.category === 'all' ? '全部工作流' : categoryName(state.category);
  $('workflow-count').textContent = `${items.length} 个工作流`;
  $('footer-count').textContent = state.search ? `找到 ${items.length} 个 · 共 ${state.workflows.length} 个工作流` : `共 ${state.workflows.length} 个工作流`;
  $('gallery').setAttribute('aria-busy', 'false');
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const card = document.createElement('article'); card.className = 'workflow-card'; card.tabIndex = 0; card.draggable = true;
    card.classList.toggle('text-generating', pendingTextIds.has(String(item.id))); card.setAttribute('aria-busy', String(pendingTextIds.has(String(item.id))));
    card.classList.toggle('has-media-cover', item.coverType === 'image' || item.coverType === 'video');
    card.dataset.id = item.id; card.setAttribute('aria-label', `${displayName(item)}，单击选中，双击打开`); card.setAttribute('aria-selected', String(state.selection.has(String(item.id))));
    const thumbnail = document.createElement('div'); thumbnail.className = 'thumbnail';
    const graphUrl = item.previewUrl || `/api/workflows/${encodeURIComponent(item.id)}/preview.svg`;
    const image = document.createElement('img'); image.className = 'card-cover-image'; image.src = item.posterUrl || item.coverUrl || graphUrl; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.draggable = false;
    const graphImage = document.createElement('img'); graphImage.className = 'card-graph-image'; graphImage.src = graphUrl; graphImage.alt = ''; graphImage.loading = 'lazy'; graphImage.decoding = 'async'; graphImage.draggable = false;
    image.onerror = () => { if (image.src !== graphImage.src) image.src = graphImage.src; };
    const more = document.createElement('button'); more.className = 'card-more'; more.textContent = '···'; more.setAttribute('aria-label', `${displayName(item)}的更多操作`); more.title = '更多操作';
    more.onclick = (event) => { event.stopPropagation(); contextSelect(item); const box = more.getBoundingClientRect(); showMenu(item, box.right - 185, box.bottom + 5); };
    const badge = document.createElement('span'); badge.className = 'card-category'; badge.textContent = categoryName(item.category);
    const uploadHint = document.createElement('div'); uploadHint.className = 'cover-drop-hint'; uploadHint.textContent = '松开以更换封面';
    thumbnail.append(image, graphImage, more, badge, uploadHint);
    if (item.textCover) {
      const textCover = document.createElement('div'); textCover.className = 'card-text-cover';
      textRenderers.push(renderTextCover(textCover, item.textCover)); thumbnail.insertBefore(textCover, more); card.classList.add('has-text-cover');
    } else card.classList.add('text-cover-fallback');
    if (item.coverType === 'video' && item.coverVideoUrl) {
      const video = document.createElement('video'); video.className = 'card-cover-video'; video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'none'; video.poster = item.posterUrl || item.coverUrl || ''; video.dataset.clip = item.coverVideoUrl; video.draggable = false;
      thumbnail.insertBefore(video, graphImage); videoPool.observe(video);
    }
    const info = document.createElement('div'); info.className = 'card-info';
    const name = document.createElement('h2'); name.className = 'card-title'; name.textContent = displayName(item); name.title = displayName(item);
    const subtitle = document.createElement('p'); subtitle.className = 'card-subtitle';
    const date = document.createElement('span'); date.textContent = `${state.sort === 'lastUsed' ? '使用' : '编辑'} ${dateText(state.sort === 'lastUsed' ? item.lastUsed : item.modified)}`;
    date.title = `最近编辑：${dateText(item.modified, true)}\n最近使用：${dateText(item.lastUsed, true)}`;
    const separator = document.createElement('span'); separator.className = 'sep'; separator.textContent = '·';
    const nodes = document.createElement('span'); nodes.textContent = `${item.nodeCount ?? 0} 个节点`;
    subtitle.append(date, separator, nodes); info.append(name, subtitle); card.append(thumbnail, info);
    card.onclick = (event) => { if (event.detail > 1) return; selectWorkflow(item, event); };
    card.ondblclick = (event) => { if (event.target.closest('button')) return; event.preventDefault(); clearCardClick(item.id); openWorkflow(item); };
    card.onkeydown = (event) => { if (event.target !== card) return; if (event.key === 'Enter') { event.preventDefault(); selectWorkflow(item); openWorkflow(item); } if (event.key === ' ') { event.preventDefault(); selectWorkflow(item, event); } if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); contextSelect(item); const box = card.getBoundingClientRect(); showMenu(item, box.left + 20, box.top + 25); } };
    card.oncontextmenu = (event) => { event.preventDefault(); contextSelect(item); showMenu(item, event.clientX, event.clientY); };
    card.onmouseenter = () => prefetchGraph(item);
    card.onfocusin = () => prefetchGraph(item);
    card.ondragstart = (event) => beginDrag(event, item, card);
    card.ondragend = () => card.classList.remove('dragging');
    card.ondragenter = card.ondragover = (event) => { if (!isCoverMediaDrag(event.dataTransfer)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; $('drop-target').hidden = true; card.classList.add('cover-drop-active'); };
    card.ondragleave = (event) => { if (!card.contains(event.relatedTarget)) card.classList.remove('cover-drop-active'); };
    card.ondrop = (event) => { if (!isCoverMediaDrag(event.dataTransfer)) return; event.preventDefault(); event.stopPropagation(); card.classList.remove('cover-drop-active'); dragDepth = 0; $('drop-target').hidden = true; const media = readCoverMedia(event.dataTransfer), file = [...event.dataTransfer.files].find(file => isImageFile(file) || isVideoFile(file)); if (media || file) saveCover(item, media || file); else importDrop(event.dataTransfer); };
    fragment.append(card);
  }
  $('gallery').replaceChildren(fragment);
  updateCoverMode(state.coverMode, false); updateCoverOptions(false); updateSelectionUI();
  $('empty-state').hidden = items.length > 0;
  $('empty-title').textContent = state.search ? '没有找到匹配的工作流' : state.workflows.length ? '这个分类还没有工作流' : '还没有工作流';
  $('empty-description').textContent = state.search ? '试试其他关键词，或切换到全部工作流。' : '将工作流 JSON 拖到这里，或点击“导入工作流”。';
}

function loadingSkeletons() {
  for (let i = 0; i < 8; i++) { const card = document.createElement('div'); card.className = 'workflow-card skeleton'; card.innerHTML = '<div class="thumbnail"></div><div class="card-info"><div class="card-title"></div><div class="card-subtitle"></div></div>'; $('gallery').append(card); }
}

async function bootstrap({ manual = false, initial = false } = {}) {
  if (state.loading || sizeDragging) return;
  state.loading = true;
  const generation = ++state.generation;
  if (manual) $('refresh').disabled = true;
  try {
    const payload = await request('/api/bootstrap');
    if (generation !== state.generation) return;
    const signature = JSON.stringify([payload.categories, payload.workflows]);
    const previous = JSON.stringify([state.categories, state.workflows]);
    state.token = payload.token || state.token; state.version = payload.version || state.version; state.comfy = payload.comfy || {};
    state.categories = payload.categories || []; state.workflows = payload.workflows || [];
    if (state.category !== 'all' && !state.categories.some((item) => item.id === state.category)) state.category = 'all';
    $('version').textContent = state.version ? `V${state.version.replace(/^v/i, '')}` : '';
    updateConnection();
    if (initial || signature !== previous) { renderCategories(); renderGallery(); }
    $('load-error').hidden = true;
    if (manual) toast('工作流已刷新', 'success');
  } catch (error) {
    if (initial || manual) { $('load-error-message').textContent = error.message; $('load-error').hidden = false; }
    if (initial) { $('gallery').replaceChildren(); $('gallery').setAttribute('aria-busy', 'false'); $('footer-count').textContent = '连接失败'; }
    if (manual) toast(error.message, 'error');
    state.comfy = {}; updateConnection();
  } finally { state.loading = false; $('refresh').disabled = false; }
}

async function fetchGraph(item) {
  const key = `${item.id}:${item.modified}`;
  if (graphCache.has(key)) { const value = graphCache.get(key); graphCache.delete(key); graphCache.set(key, value); return value.workflow; }
  if (pendingGraphs.has(key)) return pendingGraphs.get(key);
  const pending = request(`/api/workflows/${encodeURIComponent(item.id)}/json`).then((workflow) => {
    const bytes = JSON.stringify(workflow).length * 2;
    if (bytes <= 16 * 1024 * 1024 && !shuttingDown) {
      graphCache.set(key, { workflow, bytes }); graphCacheBytes += bytes;
      while (graphCache.size > 6 || graphCacheBytes > 16 * 1024 * 1024) { const oldest = graphCache.keys().next().value; graphCacheBytes -= graphCache.get(oldest).bytes; graphCache.delete(oldest); }
    }
    return workflow;
  }).finally(() => pendingGraphs.delete(key));
  pendingGraphs.set(key, pending); return pending;
}
function prefetchGraph(item) { if (pendingGraphs.size < 2) fetchGraph(item).catch(() => {}); }
function beginDrag(event, item, card) {
  if (!event.dataTransfer) return;
  const payload = { id: item.id, path: item.path, name: displayName(item) };
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-codex-workflow-library', JSON.stringify(payload));
  const cached = graphCache.get(`${item.id}:${item.modified}`)?.workflow;
  if (cached) {
    const json = JSON.stringify(cached);
    event.dataTransfer.setData('text/plain', json);
    try { event.dataTransfer.items.add(new File([json], `${displayName(item).replace(/[<>:"/\\|?*]/g, '_')}.json`, { type: 'application/json' })); } catch { /* Custom MIME remains available for the ComfyUI bridge. */ }
  } else {
    event.dataTransfer.setData('text/plain', JSON.stringify(payload));
    prefetchGraph(item);
  }
  event.dataTransfer.setData('DownloadURL', `application/json:${displayName(item).replace(/[:/\\]/g, '_')}.json:${location.origin}/api/workflows/${encodeURIComponent(item.id)}/json`);
  card.classList.add('dragging');
}

function showMenu(item, x, y) {
  const menu = $('context-menu'); menu.replaceChildren();
  const action = (name, handler) => { const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem'; button.textContent = name; button.onclick = () => { hideMenu(); handler(); }; menu.append(button); };
  const divider = () => { const element = document.createElement('div'); element.className = 'menu-divider'; element.role = 'separator'; menu.append(element); };
  const items = selectedItems(), multiple = items.length > 1;
  if (!multiple) {
    action('在 ComfyUI 打开', () => openWorkflow(item));
    action('预览工作流', () => openPreview(item)); divider();
    action('更换封面…', () => chooseCover(item));
    action('恢复自动封面', () => restoreCover(item));
    if (item.textCover) { action('编辑文字', () => editTextCover(item)); action('重新生成', () => editTextCover(item, true)); }
    else action('文字封面', () => editTextCover(item));
    action('编辑名称与分类…', () => editWorkflow(item)); divider();
    action('下载工作流 JSON', () => downloadWorkflow(item));
  } else action('文字封面', () => generateSelectedTextCovers());
  action(multiple ? `复制 ${items.length} 项` : '复制', copySelection);
  if (state.clipboardIds.length && state.category !== 'all') action('粘贴到此分类', pasteSelection);
  divider();
  action(state.category === 'all' ? '移出工作流库' : '从此分类移出', () => removeWorkflow(item));
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
  menu.querySelector('button').focus({ preventScroll: true });
}
function hideMenu() { $('context-menu').hidden = true; }

async function removeWorkflow(item) {
  if (item && !state.selection.has(String(item.id))) selectWorkflow(item);
  removeIds = selectedItems().map(item => item.id); if (!removeIds.length) return;
  $('remove-description').textContent = state.category === 'all' ? `将 ${removeIds.length} 项移出工作流库？` : `从“${categoryName(state.category)}”移出 ${removeIds.length} 项？`;
  $('remove-dialog').showModal();
}

function mergeWorkflowResults(workflows) {
  if (!Array.isArray(workflows)) return;
  state.generation++;
  const updated = new Map(workflows.map(item => [String(item.id), item]));
  state.workflows = state.workflows.map(item => updated.get(String(item.id)) || item);
  for (const item of workflows) if (!state.workflows.some(current => String(current.id) === String(item.id))) state.workflows.push(item);
  renderCategories(); renderGallery();
}
function copySelection() {
  state.clipboardIds = selectedItems().map(item => item.id); updateSelectionUI();
  if (state.clipboardIds.length) toast(`已复制 ${state.clipboardIds.length} 项`);
}
async function pasteSelection() {
  if (!state.clipboardIds.length) return;
  if (state.category === 'all') { toast('请先选择要粘贴到的分类'); return; }
  const notice = toast('正在粘贴…', 'pending', true); $('paste-selected').disabled = true;
  try {
    const result = await request('/api/collections/paste', { method: 'POST', body: { ids: state.clipboardIds, category: state.category } });
    mergeWorkflowResults(result.workflows); state.selection = new Set((result.workflows || []).map(item => String(item.id))); updateSelectionUI();
    const failed = result.errors?.length || 0;
    notice.update(failed ? `已粘贴 ${result.workflows?.length || 0} 项，${failed} 项失败` : `已粘贴 ${result.workflows?.length || 0} 项`, failed ? 'error' : 'success');
  } catch (error) { notice.update(error.message, 'error'); } finally { updateSelectionUI(); }
}
function updateTextCoverExample() {
  const text = { title: $('text-cover-title').value.trim(), subtitle: $('text-cover-subtitle').value.trim() };
  if (textModalRenderer?.update) textModalRenderer.update(text); else { textModalRenderer?.dispose?.(); textModalRenderer = renderTextCover($('text-cover-example'), text); }
}
function setTextGenerationPending(ids, pending) {
  const keys = new Set(ids.map(String));
  for (const id of keys) { if (pending) pendingTextIds.add(id); else pendingTextIds.delete(id); }
  for (const card of $('gallery').querySelectorAll('.workflow-card')) if (keys.has(card.dataset.id)) { card.classList.toggle('text-generating', pending); card.setAttribute('aria-busy', String(pending)); }
}
function generationBeat(started) {
  const remaining = Math.max(0, 220 - (performance.now() - started));
  return remaining ? new Promise(resolve => setTimeout(resolve, remaining)) : Promise.resolve();
}
function animateTextResults(workflows) {
  const ids = new Set((workflows || []).filter(item => item.textCover).map(item => String(item.id)));
  requestAnimationFrame(() => { if (shuttingDown) return; for (const card of $('gallery').querySelectorAll('.workflow-card')) if (ids.has(card.dataset.id)) { const cover = card.querySelector('.card-text-cover'); if (cover?.isConnected) animateTextCover(cover); } });
}
async function editTextCover(item, regenerate = false) {
  textCoverTarget = item; const generation = ++textCoverGeneration;
  const nonemptyTitle = value => typeof value === 'string' && value.trim() ? value : null;
  const fallbackTitle = nonemptyTitle(displayName(item)) || '未命名工作流';
  $('text-cover-heading').textContent = item.textCover && !regenerate ? '编辑文字' : '文字封面';
  $('text-cover-title').value = nonemptyTitle(item.textCover?.title) || nonemptyTitle(item.textSuggestion?.title) || fallbackTitle;
  $('text-cover-subtitle').value = item.textCover != null ? item.textCover.subtitle ?? '' : item.textSuggestion?.subtitle ?? '';
  $('text-cover-error').hidden = true; $('text-cover-loading').hidden = false; $('save-text-cover').disabled = true;
  $('text-cover-dialog').showModal(); updateTextCoverExample();
  if (item.textCover && !regenerate) { $('text-cover-loading').hidden = true; $('save-text-cover').disabled = false; return; }
  const edits = { ...textCoverEdits };
  const started = performance.now(); $('text-cover-example').classList.add('text-generating');
  try {
    const result = await request(`/api/workflows/${encodeURIComponent(item.id)}/text-cover/suggestion`);
    await generationBeat(started);
    if (generation !== textCoverGeneration || !$('text-cover-dialog').open) return;
    if (textCoverEdits.title === edits.title) $('text-cover-title').value = nonemptyTitle(result.suggestion?.title) || nonemptyTitle($('text-cover-title').value) || fallbackTitle;
    if (textCoverEdits.subtitle === edits.subtitle && result.suggestion?.subtitle != null) $('text-cover-subtitle').value = result.suggestion.subtitle;
    updateTextCoverExample(); animateTextCover($('text-cover-example'));
  } catch (error) { if (generation === textCoverGeneration) { $('text-cover-error').textContent = error.message; $('text-cover-error').hidden = false; } }
  finally { if (generation === textCoverGeneration) { $('text-cover-example').classList.remove('text-generating'); $('text-cover-loading').hidden = true; $('save-text-cover').disabled = false; } }
}
async function generateSelectedTextCovers() {
  const items = selectedItems(); if (!items.length) return;
  if (items.length === 1) { editTextCover(items[0]); return; }
  const notice = toast(`正在生成 ${items.length} 个文字封面…`, 'pending', true); $('selected-text-cover').disabled = true;
  const ids = items.map(item => item.id), started = performance.now(); setTextGenerationPending(ids, true);
  try {
    const result = await request('/api/text-covers', { method: 'POST', body: { ids: items.map(item => item.id), regenerate: true }, timeout: 60000 });
    await generationBeat(started);
    mergeWorkflowResults(result.workflows); if (result.workflows?.length) updateCoverMode('text');
    animateTextResults(result.workflows);
    const failed = result.errors?.length || 0;
    notice.update(failed ? `已生成 ${result.workflows?.length || 0} 个，${failed} 个失败` : `已生成 ${result.workflows?.length || 0} 个文字封面`, failed ? 'error' : 'success');
  } catch (error) { notice.update(error.message, 'error'); } finally { setTextGenerationPending(ids, false); updateSelectionUI(); }
}
$('text-cover-title').addEventListener('input', () => { if ($('text-cover-dialog').open) textCoverEdits.title++; updateTextCoverExample(); });
$('text-cover-subtitle').addEventListener('input', () => { if ($('text-cover-dialog').open) textCoverEdits.subtitle++; updateTextCoverExample(); });
$('text-cover-dialog').addEventListener('close', () => { textCoverGeneration++; textCoverTarget = null; textModalRenderer?.dispose?.(); textModalRenderer = null; $('text-cover-example').classList.remove('text-generating'); $('text-cover-example').replaceChildren(); });
$('text-cover-form').addEventListener('submit', async event => {
  event.preventDefault(); const item = textCoverTarget; if (!item) return;
  const title = $('text-cover-title').value.trim(), subtitle = $('text-cover-subtitle').value.trim(); if (!title) { $('text-cover-title').focus(); return; }
  $('save-text-cover').disabled = true;
  const started = performance.now(); setTextGenerationPending([item.id], true); $('text-cover-example').classList.add('text-generating');
  try {
    const result = await request(`/api/workflows/${encodeURIComponent(item.id)}/text-cover`, { method: 'POST', body: { title, subtitle } });
    await generationBeat(started);
    if (result.workflow) mergeWorkflowResults([result.workflow]); updateCoverMode('text'); $('text-cover-dialog').close(); animateTextResults(result.workflow ? [result.workflow] : []); toast('文字封面已保存', 'success');
  } catch (error) { $('text-cover-error').textContent = error.message; $('text-cover-error').hidden = false; } finally { setTextGenerationPending([item.id], false); $('text-cover-example').classList.remove('text-generating'); $('save-text-cover').disabled = false; }
});
$('remove-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!removeIds.length) return; $('confirm-remove').disabled = true;
  try {
    const result = await request('/api/workflows/batch', { method: 'POST', body: { operation: 'remove', ids: removeIds, category: state.category } });
    if (state.preview && removeIds.some(id => String(id) === String(state.preview.id))) closePreview();
    state.selection.clear(); state.selected = null; $('remove-dialog').close(); await bootstrap();
    toast(result.errors?.length ? `部分移出失败：${result.errors[0].error}` : '已移出，原文件保留', result.errors?.length ? 'error' : 'success');
  } catch (error) { toast(error.message, 'error'); } finally { $('confirm-remove').disabled = false; }
});

async function downloadWorkflow(item) {
  try { const workflow = await fetchGraph(item); const url = URL.createObjectURL(new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${displayName(item).replace(/[<>:"/\\|?*]/g, '_')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 15000); } catch (error) { toast(error.message, 'error'); }
}

function reserveComfyWindow() {
  const tab = window.open(state.comfy.online ? state.comfy.url || 'http://127.0.0.1:8000/' : '', 'comfy-workflow-library');
  if (!tab) { toast('请允许浏览器弹出 ComfyUI 窗口', 'error'); return null; }
  try {
    if (tab.location.href === 'about:blank') {
      tab.document.title = '正在打开 ComfyUI';
      tab.document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#181818;color:#c9c9c9;font:15px "Segoe UI","Microsoft YaHei",sans-serif';
      tab.document.body.textContent = '正在等待 ComfyUI 启动…';
    }
  } catch { /* Keep an existing ComfyUI tab intact until its server is ready. */ }
  return tab;
}

async function openComfy() {
  const tab = reserveComfyWindow();
  const notice = toast('正在打开 ComfyUI…', 'pending', true);
  $('open-comfy').disabled = true;
  try {
    let status = await request('/api/start', { method: 'POST', body: {}, timeout: 30000 });
    const started = Date.now();
    while (!status.online && !shuttingDown && Date.now() - started < 90000) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await request('/api/status'); status = { ...response.comfy, url: status.url || response.comfy?.url };
    }
    if (shuttingDown) return;
    if (!status.online) throw new Error('ComfyUI 尚未启动，请检查桌面版的实例状态后重试');
    if (tab && !tab.closed) tab.location = status.url || 'http://127.0.0.1:8000/';
    notice.update('ComfyUI 已打开', 'success'); await bootstrap();
  } catch (error) { if (!shuttingDown) notice.update(error.message, 'error'); }
  finally { $('open-comfy').disabled = false; }
}

async function openWorkflow(item) {
  if (embedded) { openInHost(item); return; }
  if (jobs.has(item.id)) { toast('这个工作流正在打开，请稍候'); return; }
  jobs.add(item.id);
  let comfyWindow;
  if (!state.comfy.bridge) comfyWindow = reserveComfyWindow();
  const notice = toast(`正在打开「${displayName(item)}」`, 'pending', true);
  try {
    const result = await request('/api/open', { method: 'POST', body: { id: item.id }, timeout: 30000 });
    let navigated = false;
    if (comfyWindow && state.comfy.online && result.url) { comfyWindow.location = result.url; navigated = true; }
    let status = result;
    const started = Date.now();
    let lastStatusCheck = 0;
    while (!['success', 'failed'].includes(status.status) && !shuttingDown && Date.now() - started < 110000) {
      if (status.status === 'opening') notice.update('ComfyUI 正在载入工作流…', 'pending');
      else notice.update(state.comfy.online ? '正在等待 ComfyUI 连接…' : '正在启动 ComfyUI，请稍候…', 'pending');
      await new Promise((resolve) => setTimeout(resolve, document.hidden ? 2200 : 900));
      if (!navigated && comfyWindow && !comfyWindow.closed && Date.now() - lastStatusCheck > 3000) {
        lastStatusCheck = Date.now();
        const serviceStatus = await request('/api/status');
        state.comfy = serviceStatus.comfy || state.comfy; updateConnection();
        if (state.comfy.online) { comfyWindow.location = result.url || state.comfy.url; navigated = true; }
      }
      status = await request(`/api/jobs/${encodeURIComponent(result.jobId || result.id)}`);
    }
    if (shuttingDown) return;
    if (status.status !== 'success') throw new Error(status.error || 'ComfyUI 尚未完成连接，请打开 ComfyUI 页面后重试');
    notice.update(`已打开「${displayName(item)}」`, 'success');
    await bootstrap();
  } catch (error) { if (!shuttingDown) notice.update(error.message, 'error'); }
  finally { jobs.delete(item.id); }
}

function openPreview(item) {
  if ($('preview-dialog').open && state.preview?.id === item.id) return;
  state.preview = item; state.previewMode = 'graph';
  $('preview-title').textContent = displayName(item);
  $('preview-meta').textContent = `${categoryName(item.category)} · ${item.nodeCount ?? 0} 个节点 · 最近编辑 ${dateText(item.modified, true)}`;
  $('preview-path').textContent = item.path || ''; $('preview-path').title = item.path || '';
  if (!$('preview-dialog').open) $('preview-dialog').showModal();
  syncCoverPlayback();
  loadPreview(); prefetchGraph(item);
}
function clearPreviewMedia() {
  previewRequest?.abort(); previewRequest = null; previewDimensions = null;
  $('preview-vector').replaceChildren(); $('preview-vector').hidden = true;
  $('preview-image').removeAttribute('src'); $('preview-image').onload = null; $('preview-image').onerror = null; $('preview-image').hidden = true;
  $('preview-video').pause(); $('preview-video').removeAttribute('src'); $('preview-video').removeAttribute('poster'); $('preview-video').load(); $('preview-video').hidden = true;
}
async function loadPreview() {
  const item = state.preview;
  if (!item) return;
  const generation = ++previewGeneration;
  $('show-graph').classList.toggle('selected', state.previewMode === 'graph'); $('show-cover').classList.toggle('selected', state.previewMode === 'cover');
  $('preview-loading').hidden = false; $('preview-error').hidden = true;
  clearPreviewMedia();
  const image = $('preview-image');
  const finish = (width, height) => { if (generation !== previewGeneration || !$('preview-dialog').open) return; previewDimensions = { width, height }; $('preview-content').style.width = `${width}px`; $('preview-content').style.height = `${height}px`; $('preview-loading').hidden = true; fitPreview(); };
  if (state.previewMode === 'graph') {
    const controller = new AbortController(); previewRequest = controller;
    try {
      const url = new URL(item.previewUrl || `/api/workflows/${encodeURIComponent(item.id)}/preview.svg`, location.origin);
      if (url.origin !== location.origin) throw new Error('工作流预览来源无效');
      const response = await fetch(url, { signal: controller.signal }); if (!response.ok) throw new Error('工作流预览未能载入');
      const source = await response.text(); if (source.length > 16 * 1024 * 1024) throw new Error('工作流预览过大');
      if (generation !== previewGeneration || !$('preview-dialog').open) return;
      const svg = sanitizeWorkflowSVG(source), box = svg.viewBox.baseVal;
      const width = box.width || parseFloat(svg.getAttribute('width')) || 1600, height = box.height || parseFloat(svg.getAttribute('height')) || 900;
      svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
      $('preview-vector').append(svg); $('preview-vector').hidden = false; finish(width, height);
    } catch (error) { if (error.name !== 'AbortError' && generation === previewGeneration) { $('preview-loading').hidden = true; $('preview-error').hidden = false; } }
    return;
  }
  if (item.coverType === 'video' && item.coverVideoUrl && state.playDynamic) {
    const video = $('preview-video'); video.poster = item.posterUrl || item.coverUrl || ''; video.src = item.coverVideoUrl; video.hidden = false;
    video.onloadedmetadata = () => { if (generation !== previewGeneration || !$('preview-dialog').open) return; finish(video.videoWidth || 640, video.videoHeight || 360); if (!document.hidden) video.play().catch(() => {}); };
    video.onerror = () => { if (generation === previewGeneration) { $('preview-loading').hidden = true; $('preview-error').hidden = false; } };
    return;
  }
  image.onload = () => { if (generation !== previewGeneration || !$('preview-dialog').open) return; image.hidden = false; finish(image.naturalWidth, image.naturalHeight); };
  image.onerror = () => { if (generation !== previewGeneration) return; $('preview-loading').hidden = true; $('preview-error').hidden = false; };
  image.src = item.posterUrl || item.coverUrl || item.previewUrl;
  if (image.complete && image.naturalWidth) image.onload();
}
function fitPreview() {
  const viewport = $('preview-viewport');
  if (!previewDimensions) return;
  zoom.fit = Math.min((viewport.clientWidth - 44) / previewDimensions.width, (viewport.clientHeight - 44) / previewDimensions.height, 2);
  zoom.scale = zoom.fit; zoom.x = 0; zoom.y = 0; applyZoom();
}
function applyZoom() { $('preview-content').style.transform = `translate(-50%,-50%) translate(${zoom.x}px,${zoom.y}px) scale(${zoom.scale})`; $('zoom-value').textContent = `${Math.round(zoom.scale / zoom.fit * 100)}%`; }
function changeZoom(multiplier, x = 0, y = 0) { const previous = zoom.scale; zoom.scale = Math.max(zoom.fit * .25, Math.min(zoom.fit * 12, zoom.scale * multiplier)); const ratio = zoom.scale / previous; zoom.x = x - (x - zoom.x) * ratio; zoom.y = y - (y - zoom.y) * ratio; applyZoom(); }
function closePreview() { $('preview-dialog').close(); }
$('preview-dialog').addEventListener('close', () => { previewGeneration++; state.preview = null; clearPreviewMedia(); zoom.pointer = null; syncCoverPlayback(); });
$('preview-dialog').addEventListener('click', (event) => { if (event.target === $('preview-dialog')) { const box = $('preview-dialog').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closePreview(); } });
$('preview-viewport').addEventListener('wheel', (event) => { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); changeZoom(Math.exp(-event.deltaY * .0015), event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2); }, { passive: false });
$('preview-viewport').addEventListener('pointerdown', (event) => { if (event.button !== 0) return; zoom.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: zoom.x, startY: zoom.y }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.classList.add('panning'); });
$('preview-viewport').addEventListener('pointermove', (event) => { if (!zoom.pointer || zoom.pointer.id !== event.pointerId) return; zoom.x = zoom.pointer.startX + event.clientX - zoom.pointer.x; zoom.y = zoom.pointer.startY + event.clientY - zoom.pointer.y; applyZoom(); });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('preview-viewport').addEventListener(type, () => { zoom.pointer = null; $('preview-viewport').classList.remove('panning'); });

function editWorkflow(item) {
  state.editing = item; $('edit-name').value = displayName(item);
  $('edit-category').replaceChildren(...state.categories.map((category) => { const option = document.createElement('option'); option.value = category.id; option.textContent = category.name; return option; }));
  $('edit-category').value = item.category; $('edit-dialog').showModal(); setTimeout(() => $('edit-name').focus(), 0);
}
async function restoreCover(item) { try { await request(`/api/workflows/${encodeURIComponent(item.id)}/cover`, { method: 'DELETE' }); toast('已恢复自动封面', 'success'); await bootstrap(); } catch (error) { toast(error.message, 'error'); } }
function readFileAsDataURL(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取图片')); reader.readAsDataURL(file); }); }
async function saveCover(item, source) {
  if (!source || !item) return;
  const file = source instanceof File ? source : null;
  if (file && !isImageFile(file) && !isVideoFile(file)) { toast('请选择图片或视频封面', 'error'); return; }
  if (file && file.size > (isVideoFile(file) ? 64 : 12) * 1024 * 1024) { toast(isVideoFile(file) ? '视频文件不能超过 64 MB' : '封面图片不能超过 12 MB', 'error'); return; }
  const card = [...$('gallery').querySelectorAll('.workflow-card')].find(card => card.dataset.id === String(item.id));
  if (card?.classList.contains('cover-saving')) return;
  card?.classList.add('cover-saving');
  const notice = toast('正在保存封面…', 'pending', true);
  try {
    const endpoint = `/api/workflows/${encodeURIComponent(item.id)}`;
    const result = file && isVideoFile(file)
      ? await request(`${endpoint}/cover-file`, { method: 'POST', rawBody: file, headers: { 'Content-Type': file.type || 'video/mp4', 'X-Filename': encodeURIComponent(file.name) }, timeout: 120000 })
      : await request(`${endpoint}/cover`, { method: 'POST', body: file ? { image: await readFileAsDataURL(file) } : { media: source }, timeout: 120000 });
    // A scan that began before this upload must not repaint an older cover.
    state.generation++;
    if (result.workflow) state.workflows = state.workflows.map(entry => String(entry.id) === String(item.id) ? result.workflow : entry);
    updateCoverMode('custom'); state.selected = item.id; state.selection = new Set([String(item.id)]); renderGallery();
    notice.update('封面已更新', 'success'); selectWorkflow(workflowById(item.id));
  } catch (error) { notice.update(error.message, 'error'); } finally { card?.classList.remove('cover-saving'); }
}
$('cover-file').addEventListener('change', () => saveCover(state.coverTarget, $('cover-file').files[0]));
$('edit-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!state.editing) return;
  const name = $('edit-name').value.trim(); if (!name) { $('edit-name').focus(); return; }
  const submit = event.currentTarget.querySelector('[type=submit]'); submit.disabled = true;
  try { const id = state.editing.id; await request(`/api/workflows/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name, category: $('edit-category').value } }); $('edit-dialog').close(); await bootstrap(); if (state.preview?.id === id) { const updated = workflowById(id); if (updated) { state.preview = null; openPreview(updated); } } toast('工作流信息已保存', 'success'); } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; }
});
$('category-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const name = $('category-name').value.trim(); if (!name) return;
  const submit = event.currentTarget.querySelector('[type=submit]'); submit.disabled = true;
  try { const result = await request('/api/categories', { method: 'POST', body: { name } }); $('category-dialog').close(); if (result.category?.id) state.category = result.category.id; await bootstrap(); toast('分类已创建', 'success'); } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; }
});

async function importPayloads(payloads) {
  if (!payloads.length) return;
  const notice = toast(`正在收录 ${payloads.length} 个工作流…`, 'pending', true);
  let added = 0, duplicates = 0, failures = [];
  for (let index = 0; index < payloads.length; index++) {
    notice.update(`正在收录 ${index + 1} / ${payloads.length}…`, 'pending');
    try {
      let payload = payloads[index];
      if (payload.file) {
        const file = payload.file;
        if (file.size > 16 * 1024 * 1024) throw new Error(`${file.name} 超过 16 MB`);
        let workflow; try { workflow = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} 不是有效的 JSON`); }
        payload = { name: file.name.replace(/\.json$/i, ''), workflow };
      }
      if (state.category !== 'all') payload.category = state.category;
      const result = await request('/api/import', { method: 'POST', body: payload, timeout: 30000 });
      if (result.duplicate) duplicates++; else added++;
    } catch (error) { failures.push(error.message); }
  }
  await bootstrap();
  if (failures.length) notice.update(`${added ? `已收录 ${added} 个，` : ''}${duplicates ? `${duplicates} 个已在库中，` : ''}${failures.length} 个失败：${failures[0]}`, 'error');
  else notice.update(added ? `已收录 ${added} 个工作流${duplicates ? `，${duplicates} 个已在库中` : ''}` : `${duplicates} 个工作流已在库中`, 'success');
}
window.addEventListener('message', (event) => {
  if (!embedded || event.source !== window.parent || !hostOrigins.includes(event.origin) || event.data?.channel !== 'codex-workflow-library') return;
  const message = event.data;
  if (message.type === 'host-ready') {
    hostOrigin = event.origin; hostReady = true; clearInterval(readyTimer); return;
  }
  if (message.type === 'opened' || message.type === 'error') {
    const pending = hostOpenings.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timeout); hostOpenings.delete(String(message.id));
    pending.notice.update(message.type === 'opened' ? '已打开工作流' : message.message || '工作流未能打开，请重试', message.type === 'opened' ? 'success' : 'error');
  }
  if (message.type === 'workflow-drag') {
    const payload = message.payload;
    if (!payload || typeof payload !== 'object' || (typeof payload.path !== 'string' && !payload.workflow)) { toast('没有识别到工作流，请重试', 'error'); return; }
    importPayloads([{ name: payload.name || '未命名工作流', ...(payload.path ? { path: payload.path } : {}), ...(payload.workflow ? { workflow: payload.workflow } : {}) }]);
  }
});
async function importDrop(data) {
  try {
    const reference = readWorkflowReference(data);
    if (reference) { await importPayloads([reference]); return; }
    for (const type of ['application/x-comfy-workflow', 'application/x-codex-workflow-library']) {
      const raw = data.getData(type);
      if (!raw) continue;
      const payload = JSON.parse(raw);
      if (type === 'application/x-codex-workflow-library') {
        const existing = workflowById(payload.id);
        if (existing) { toast('这个工作流已在库中', 'success'); return; }
      }
      if (payload.path || payload.workflow) { await importPayloads([{ name: payload.name || '未命名工作流', path: payload.path, ...(payload.workflow ? { workflow: payload.workflow } : {}) }]); return; }
    }
    const files = [...data.files].filter((file) => /\.json$/i.test(file.name) || file.type === 'application/json');
    if (files.length) { await importPayloads(files.map((file) => ({ file }))); return; }
    const raw = data.getData('text/plain') || data.getData('application/json');
    if (raw) {
      let payload; try { payload = JSON.parse(raw); } catch { throw new Error('请拖入工作流 JSON 文件或 ComfyUI 工作流'); }
      if (payload.workflow || payload.path) await importPayloads([{ name: payload.name || '未命名工作流', path: payload.path, workflow: payload.workflow }]);
      else if (payload.nodes) await importPayloads([{ name: '拖入的工作流', workflow: payload }]);
      else throw new Error('没有识别到工作流，请拖入工作流 JSON 文件');
      return;
    }
    throw new Error('支持工作流 JSON 文件和 ComfyUI 工作流');
  } catch (error) { toast(error.message, 'error'); }
}
function isSupportedDrag(data) { return data && [...data.types].some((type) => ['Files', ...MEDIA_TYPES, 'application/x-comfy-workflow', 'application/x-codex-workflow-library', 'text/plain', 'text', 'text/uri-list', 'application/json'].includes(type)); }
document.addEventListener('dragenter', (event) => { if (!isSupportedDrag(event.dataTransfer) || document.querySelector('.workflow-card.dragging')) return; event.preventDefault(); if (isCoverMediaDrag(event.dataTransfer)) { $('drop-target').hidden = true; return; } dragDepth++; $('drop-target').hidden = false; });
document.addEventListener('dragover', (event) => { if (!isSupportedDrag(event.dataTransfer)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('dragleave', (event) => { if (event.relatedTarget === null || --dragDepth <= 0) { dragDepth = 0; $('drop-target').hidden = true; } });
document.addEventListener('drop', (event) => { if (!isSupportedDrag(event.dataTransfer)) return; event.preventDefault(); dragDepth = 0; $('drop-target').hidden = true; if (document.querySelector('.workflow-card.dragging')) return; if (readWorkflowReference(event.dataTransfer)) { importDrop(event.dataTransfer); return; } if (isCoverMediaDrag(event.dataTransfer)) { toast('请把图片或视频拖到工作流封面上'); return; } importDrop(event.dataTransfer); });
document.addEventListener('dragend', () => { dragDepth = 0; $('drop-target').hidden = true; });

$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = $('search').value.trim(); renderGallery(); }, 160); });
$('sort').addEventListener('change', () => { state.sort = $('sort').value; renderGallery(); });
function applyCardSize() {
  sizeFrame = null;
  document.documentElement.style.setProperty('--card-min', `${sizeTarget}px`);
  // Keep the same card/media elements throughout the gesture. Fixed tracks
  // follow the pointer continuously instead of stretching until a column flips.
  if (sizeDragging) $('gallery').style.setProperty('--drag-card-width', `${sizeTarget}px`);
}
function finishCardSize() {
  if (sizeFrame != null) { cancelAnimationFrame(sizeFrame); applyCardSize(); }
  const animate = sizeDragging && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cards = animate ? [...$('gallery').querySelectorAll('.workflow-card')].map(card => ({ card, rect: card.getBoundingClientRect() })).filter(({ rect }) => rect.bottom > 0 && rect.top < innerHeight).slice(0, 32) : [];
  sizeDragging = false; $('gallery').classList.remove('resizing-cards');
  if (cards.length) requestAnimationFrame(() => {
    const movement = cards.filter(({ card }) => card.isConnected).map(({ card, rect }) => { const next = card.getBoundingClientRect(); return { card, x: rect.left - next.left, y: rect.top - next.top }; });
    for (const { card, x, y } of movement) if (x || y) card.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'translate(0,0)' }], { duration: 130, easing: 'ease-out' });
  });
  clearTimeout(sizePersistTimer);
  try { localStorage.setItem('workflow-library-card-size', String(sizeTarget)); } catch {}
}
$('card-size').addEventListener('pointerdown', () => { sizeDragging = true; state.generation++; $('gallery').classList.add('resizing-cards'); });
$('card-size').addEventListener('input', () => { sizeTarget = Number($('card-size').value); if (sizeFrame == null) sizeFrame = requestAnimationFrame(applyCardSize); clearTimeout(sizePersistTimer); if (!sizeDragging) sizePersistTimer = setTimeout(finishCardSize, 180); });
$('card-size').addEventListener('change', finishCardSize);
window.addEventListener('pointerup', () => { if (sizeDragging) finishCardSize(); });
window.addEventListener('pointercancel', () => { if (sizeDragging) finishCardSize(); });
$('refresh').onclick = () => bootstrap({ manual: true });
for (const button of $('cover-mode').querySelectorAll('[data-cover-mode]')) button.onclick = () => updateCoverMode(button.dataset.coverMode);
$('fill-covers').onclick = () => { state.fillCovers = !state.fillCovers; updateCoverOptions(); };
$('play-dynamic').onclick = () => { state.playDynamic = !state.playDynamic; updateCoverOptions(); };
$('selected-preview').onclick = () => { const item = workflowById(state.selected); if (item) openPreview(item); };
$('select-all').onclick = selectAllVisible;
$('copy-selected').onclick = copySelection;
$('paste-selected').onclick = pasteSelection;
$('selected-text-cover').onclick = generateSelectedTextCovers;
$('selected-cover').onclick = () => { const item = workflowById(state.selected); if (item) chooseCover(item); };
$('selected-edit').onclick = () => { const item = workflowById(state.selected); if (item) editWorkflow(item); };
$('selected-remove').onclick = () => { const item = workflowById(state.selected); if (item) removeWorkflow(item); };
$('retry-load').onclick = () => bootstrap({ manual: true, initial: state.workflows.length === 0 });
$('close-library').onclick = () => postHost('close');
$('add-category').onclick = () => { $('category-name').value = ''; $('category-dialog').showModal(); setTimeout(() => $('category-name').focus(), 0); };
$('import-button').onclick = () => { $('import-files').value = ''; $('import-files').click(); };
$('import-files').addEventListener('change', () => importPayloads([...$('import-files').files].map((file) => ({ file }))));
$('open-comfy').onclick = openComfy;
$('close-preview').onclick = closePreview;
$('show-graph').onclick = () => { state.previewMode = 'graph'; loadPreview(); };
$('show-cover').onclick = () => { state.previewMode = 'cover'; loadPreview(); };
$('zoom-out').onclick = () => changeZoom(1 / 1.25);
$('zoom-in').onclick = () => changeZoom(1.25);
$('zoom-fit').onclick = fitPreview;
$('preview-open').onclick = () => { if (state.preview) openWorkflow(state.preview); };
$('preview-edit').onclick = () => { if (state.preview) editWorkflow(state.preview); };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
document.addEventListener('pointerdown', (event) => { if (!$('context-menu').contains(event.target) && !event.target.closest('.card-more')) hideMenu(); });
document.addEventListener('keydown', (event) => {
  const editing = event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const dialogOpen = Boolean(document.querySelector('dialog[open]'));
  if (!editing && !dialogOpen && (event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 'a') { event.preventDefault(); selectAllVisible(); }
    if (key === 'c' && state.selection.size) { event.preventDefault(); copySelection(); }
    if (key === 'v' && state.clipboardIds.length) { event.preventDefault(); pasteSelection(); }
  }
  if (!editing && !dialogOpen && event.key === 'Delete' && state.selection.size) { event.preventDefault(); removeWorkflow(); }
  if (event.key === 'Escape') { const transient = !$('context-menu').hidden || dialogOpen || !$('drop-target').hidden; hideMenu(); dragDepth = 0; $('drop-target').hidden = true; if (!transient && state.selection.size) { selectWorkflow(null); event.preventDefault(); } else if (embedded && !transient) postHost('close'); }
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { event.preventDefault(); $('search').focus(); }
  if (!$('context-menu').hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const options = [...$('context-menu').querySelectorAll('button')]; const index = options.indexOf(document.activeElement); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus(); }
});
window.addEventListener('resize', () => { hideMenu(); if ($('preview-dialog').open) fitPreview(); });
window.addEventListener('blur', hideMenu);
document.addEventListener('visibilitychange', () => { syncCoverPlayback(); if (document.hidden) $('preview-video').pause(); else { if (!$('preview-video').hidden && $('preview-dialog').open) $('preview-video').play().catch(() => {}); bootstrap(); } });
window.addEventListener('pagehide', () => { shuttingDown = true; clearInterval(pollTimer); clearInterval(readyTimer); clearTimeout(searchTimer); clearTimeout(sizePersistTimer); if (sizeFrame != null) cancelAnimationFrame(sizeFrame); videoPool.clear(); for (const renderer of textRenderers.splice(0)) renderer?.dispose?.(); textModalRenderer?.dispose?.(); clearPreviewMedia(); cardClickTimers.forEach(clearTimeout); hostOpenings.forEach((pending) => { clearTimeout(pending.timeout); pending.notice.remove(); }); activeRequests.forEach((controller) => controller.abort()); graphCache.clear(); graphCacheBytes = 0; pendingGraphs.clear(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
try { const savedSize = Number(localStorage.getItem('workflow-library-card-size')); if (savedSize >= 260 && savedSize <= 560) { sizeTarget = savedSize; $('card-size').value = savedSize; document.documentElement.style.setProperty('--card-min', `${savedSize}px`); } } catch { /* Defaults work without browser storage. */ }
try { const mode = localStorage.getItem('workflow-library-cover-mode'); state.coverMode = ['custom', 'workflow', 'text'].includes(mode) ? mode : localStorage.getItem('workflow-library-show-original') === 'false' ? 'custom' : 'workflow'; } catch {}
try { state.fillCovers = localStorage.getItem('workflow-library-fill-covers') === 'true'; state.playDynamic = localStorage.getItem('workflow-library-play-dynamic') !== 'false'; } catch {}
if (embedded) {
  document.body.classList.add('embedded');
  $('open-comfy').hidden = true; $('connection').hidden = true; $('close-library').hidden = false;
  document.querySelector('.brand').href = '/?embedded=1';
  postHost('ready'); readyTimer = setInterval(() => { if (!hostReady) postHost('ready'); }, 1000);
}
loadingSkeletons();
await bootstrap({ initial: true });
pollTimer = setInterval(() => { if (!document.hidden && $('context-menu').hidden && !document.querySelector('.workflow-card.dragging')) bootstrap(); }, 15000);

$('version').onclick=()=>{ $('about-dialog').showModal(); };
