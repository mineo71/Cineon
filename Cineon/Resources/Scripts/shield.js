// Runs in every frame, in the page's own script world, because it has to intercept what the page
// does. Removes the invisible full-page layers that streaming sites use to steal the first click.
(() => {
  if (window.__cineonShield) return;
  window.__cineonShield = true;

  const handlers = window.webkit && window.webkit.messageHandlers;
  const report = () => {
    try { handlers.cineonShield.postMessage({ type: 'overlay' }); } catch (_) {}
  };

  // Player controls are often transparent full-size layers too. Never touch those.
  const PLAYER_WORDS = /player|plyr|jw|vjs|video|control|media|shaka|hls|dplayer|artplayer|flow|fluid|clappr|modal|dialog|menu|cookie|consent|login/i;

  const opacityOf = (el) => {
    let opacity = 1;
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 3; node = node.parentElement, depth++) {
      opacity *= parseFloat(getComputedStyle(node).opacity) || 0;
    }
    return opacity;
  };

  const looksEmpty = (el) => {
    if ((el.innerText || '').trim().length > 24) return false;
    if (el.querySelector('video, button, input, select, textarea, canvas')) return false;
    const images = el.querySelectorAll('img, svg');
    for (const image of images) {
      const rect = image.getBoundingClientRect();
      if (rect.width > 48 && rect.height > 48) {
        // A big image over the page is a visible ad banner, not a trap, unless it's see-through.
        return opacityOf(image) < 0.1;
      }
    }
    return true;
  };

  const isTransparent = (el) => {
    const style = getComputedStyle(el);
    if (opacityOf(el) < 0.1) return true;
    const bg = style.backgroundColor;
    const clearBackground = bg === 'transparent' || /rgba\(.*,\s*0(\.0+)?\)$/.test(bg);
    return clearBackground && style.backgroundImage === 'none';
  };

  const isClickTrap = (start) => {
    const viewportArea = window.innerWidth * window.innerHeight;
    if (!viewportArea) return null;
    let el = start;
    for (let depth = 0; el && el.nodeType === 1 && depth < 5; el = el.parentElement, depth++) {
      if (el === document.documentElement || el === document.body) return null;
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;

      const rect = el.getBoundingClientRect();
      const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      if (visibleWidth * visibleHeight < viewportArea * 0.6) continue;

      const zIndex = parseInt(style.zIndex, 10) || 0;
      if (zIndex < 100) continue;

      const identity = `${el.id} ${el.className && el.className.baseVal === undefined ? el.className : ''}`;
      if (PLAYER_WORDS.test(identity)) return null;
      if (el.closest('[class*="player" i], [id*="player" i]')) return null;
      if (el.querySelector('video')) return null;
      if (!isTransparent(el) || !looksEmpty(el)) continue;
      return el;
    }
    return null;
  };

  // Disabled per site by the app, by setting this attribute before page scripts run.
  const enabled = () => document.documentElement && !document.documentElement.hasAttribute('data-cineon-noshield');

  const intercept = (event) => {
    if (!enabled() || !event.isTrusted) return;
    const trap = isClickTrap(event.target);
    if (!trap) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const { clientX: x, clientY: y } = event;
    trap.remove();
    report();
    if (event.type === 'click') {
      const below = document.elementFromPoint(x, y);
      if (below && below.click) below.click();
    }
  };

  for (const type of ['pointerdown', 'mousedown', 'click']) {
    window.addEventListener(type, intercept, true);
  }
})();
