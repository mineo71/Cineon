// Cinema mode: isolates the player from the page around it, by making everything else invisible.
// Called on demand, in the page's top frame.
(() => {
  const CLASS_ON = '__cineon-theater';
  const CLASS_TARGET = '__cineon-theater-target';
  const CLASS_PATH = '__cineon-theater-path';
  const STYLE_ID = '__cineon-theater-style';

  const clear = () => {
    document.documentElement.classList.remove(CLASS_ON);
    document.querySelectorAll(`.${CLASS_TARGET}, .${CLASS_PATH}`).forEach((el) => {
      el.classList.remove(CLASS_TARGET, CLASS_PATH);
    });
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  };

  const area = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  };

  const findPlayer = () => {
    const candidates = [...document.querySelectorAll('video, iframe, embed, object')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width >= 240 && rect.height >= 135;
      })
      .sort((a, b) => {
        const score = (el) => area(el) + (el.tagName === 'VIDEO' ? 1e6 : 0);
        return score(b) - score(a);
      });
    let target = candidates[0];
    if (!target) return null;
    // Climb to the player's own wrapper, so its controls stay visible.
    const base = area(target);
    for (let parent = target.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (area(parent) > base * 1.25) break;
      target = parent;
    }
    return target;
  };

  const enable = () => {
    clear();
    const target = findPlayer();
    if (!target) return false;
    target.classList.add(CLASS_TARGET);
    for (let parent = target.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      parent.classList.add(CLASS_PATH);
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.${CLASS_ON}, html.${CLASS_ON} body { overflow: hidden !important; background: #000 !important; }
      html.${CLASS_ON} * { visibility: hidden !important; }
      html.${CLASS_ON} .${CLASS_TARGET}, html.${CLASS_ON} .${CLASS_TARGET} * { visibility: visible !important; }
      html.${CLASS_ON} .${CLASS_PATH} {
        transform: none !important; filter: none !important; contain: none !important;
        overflow: visible !important; clip-path: none !important;
      }
      html.${CLASS_ON} .${CLASS_TARGET} {
        position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
        max-width: none !important; max-height: none !important; margin: 0 !important;
        z-index: 2147483647 !important; background: #000 !important; border: 0 !important;
      }
      html.${CLASS_ON} .${CLASS_TARGET} video { width: 100% !important; height: 100% !important; object-fit: contain !important; }
      html.${CLASS_ON} video.${CLASS_TARGET} { object-fit: contain !important; }
    `;
    document.head.appendChild(style);
    document.documentElement.classList.add(CLASS_ON);
    return true;
  };

  window.__cineonTheater = { enable, clear };
})();
