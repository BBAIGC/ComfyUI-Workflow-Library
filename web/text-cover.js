const FONT = '"Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC","Segoe UI",sans-serif';
let measuringContext;

export function animateTextCover(element) {
  const root = element?.matches?.('.text-cover') ? element : element?.querySelector?.('.text-cover');
  if (!root || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const title = root.querySelector('.text-cover-title');
  const subtitle = root.querySelector('.text-cover-subtitle');
  const shadow = root.querySelector('.text-cover-shadow');
  for (const target of [title, subtitle, shadow]) target?.getAnimations?.().forEach(animation => animation.cancel());
  title?.animate?.([
    { opacity: 0, transform: 'translateY(9px) scale(.975)', filter: 'blur(2px)' },
    { opacity: 1, transform: 'translateY(-1px) scale(1.005)', filter: 'blur(0px)', offset: .76 },
    { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0px)' },
  ], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
  if (subtitle && !subtitle.hidden) subtitle.animate?.([
    { opacity: 0, translate: '0 5px' },
    { opacity: 1, translate: '0 0' },
  ], { duration: 300, delay: 70, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.2,1)' });
  shadow?.animate?.([{ opacity: 0 }, { opacity: .29 }], { duration: 340, delay: 90, fill: 'backwards', easing: 'ease-out' });
}

function measure(text, size, weight) {
  measuringContext ||= document.createElement('canvas').getContext('2d');
  if (!measuringContext) return text.length * size;
  measuringContext.font = `${weight} ${size}px ${FONT}`;
  return measuringContext.measureText(text).width;
}

// The projected shadow is the same text, with the same measured font size.
// No fixed-width blob or image generation is involved.
export function renderTextCover(element, initial = {}) {
  element.replaceChildren();
  const root = document.createElement('div');
  root.className = 'text-cover';
  root.setAttribute('role', 'img');
  const row = document.createElement('div');
  row.className = 'text-cover-main';
  const shadow = document.createElement('span');
  shadow.className = 'text-cover-shadow';
  shadow.setAttribute('aria-hidden', 'true');
  const face = document.createElement('span');
  face.className = 'text-cover-title';
  const subtitle = document.createElement('div');
  subtitle.className = 'text-cover-subtitle';
  row.append(shadow, face);
  root.append(row, subtitle);
  element.append(root);
  let title = '', sub = '', disposed = false, frame = null;

  function fit() {
    frame = null;
    if (disposed || !root.isConnected) return;
    const width = root.clientWidth, height = root.clientHeight;
    if (!width || !height) return;
    const nominal = height * .18;
    const titleWidth = measure(title, nominal, 900);
    const size = nominal * Math.min(1, width * .89 / Math.max(1, titleWidth));
    const nominalSub = height * .056;
    const subWidth = measure(sub, nominalSub, 600);
    root.style.setProperty('--tc-title-size', `${size}px`);
    root.style.setProperty('--tc-subtitle-size', `${nominalSub * Math.min(1, width * .92 / Math.max(1, subWidth))}px`);
  }

  function schedule() { if (!disposed && frame == null) frame = requestAnimationFrame(fit); }
  function update(value = {}) {
    title = String(value.title ?? '').trim();
    const plain = String(value.subtitle ?? '').trim().replace(/^[（(]\s*|\s*[）)]$/g, '');
    sub = plain ? `（${plain}）` : '';
    face.textContent = shadow.textContent = title;
    subtitle.textContent = sub;
    subtitle.hidden = !sub;
    root.setAttribute('aria-label', sub ? `${title} ${sub}` : title);
    schedule();
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(root);
  update(initial);
  document.fonts?.ready?.then(schedule);
  return {
    update,
    animate() { animateTextCover(root); },
    dispose() {
      disposed = true;
      if (frame != null) cancelAnimationFrame(frame);
      observer.disconnect();
      for (const target of root.querySelectorAll('*')) target.getAnimations?.().forEach(animation => animation.cancel());
      root.remove();
    },
  };
}
