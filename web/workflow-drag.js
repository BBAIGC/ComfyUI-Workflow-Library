// A saved Comfy workflow is a reference, including across Electron/browser OS
// drag sessions where application/* MIME formats and synthetic files disappear.
export function parseWorkflowReference(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 16384) return null;
  let value;
  try { value = JSON.parse(raw); } catch {
    try {
      const url = new URL(raw.trim());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '8190' || !['http:', 'https:'].includes(url.protocol) || !url.hash.startsWith('#workflow-reference=')) return null;
      value = JSON.parse(decodeURIComponent(url.hash.slice('#workflow-reference='.length)));
    } catch { return null; }
  }
  if (value?.type !== 'comfy-workflow-reference' || value.version !== 1 || typeof value.path !== 'string' || !value.path.trim() || value.path.length > 4096) return null;
  return { path: value.path, name: typeof value.name === 'string' ? value.name : '未命名工作流' };
}

export function readWorkflowReference(data) {
  // Read this before Files: the reference points at the original saved file,
  // whereas a browser-generated File is only an optional compatibility copy.
  for (const type of ['text/plain', 'text', 'text/uri-list']) {
    const raw = data.getData(type);
    const reference = parseWorkflowReference(raw);
    if (reference) return reference;
    if (type === 'text/uri-list') {
      for (const line of raw.split(/\r?\n/).filter(line => line && !line.startsWith('#'))) {
        const entry = parseWorkflowReference(line);
        if (entry) return entry;
      }
    }
  }
  return null;
}
