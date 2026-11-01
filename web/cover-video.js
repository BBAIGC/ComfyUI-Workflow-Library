// Retain only low-resolution server-generated clips, never original media.
export class CoverVideoPool {
  constructor() {
    this.visible = new Set(); this.active = new Set(); this.enabled = false;
    this.observer = new IntersectionObserver(entries => { for (const entry of entries) { if (entry.isIntersecting) this.visible.add(entry.target); else this.visible.delete(entry.target); } this.sync(); }, { threshold: .15 });
  }
  observe(video) { this.observer.observe(video); }
  setEnabled(enabled) { this.enabled = Boolean(enabled); this.sync(); }
  release(video) { video.onplaying = null; video.onerror = null; video.pause(); video.classList.remove('playing'); video.removeAttribute('src'); video.load(); this.active.delete(video); }
  sync() {
    const candidates = this.enabled && !document.hidden ? [...this.visible].filter(video => video.isConnected).slice(0, 3) : [];
    for (const video of [...this.active]) if (!candidates.includes(video)) this.release(video);
    for (const video of candidates) {
      if (this.active.has(video)) continue;
      this.active.add(video); video.src = video.dataset.clip;
      video.onplaying = () => video.classList.add('playing');
      video.onerror = () => { video.classList.remove('playing'); this.release(video); };
      video.play().catch(() => { video.classList.remove('playing'); });
    }
  }
  clear() { this.observer.disconnect(); for (const video of [...this.active]) this.release(video); this.visible.clear(); }
}
