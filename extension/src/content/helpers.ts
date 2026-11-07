// What the background asks of a page besides media.js and meta.js (`window.__cineonContent`):
// cinema mode (theater.js), the viewport for cropping photographs of the tab, and the links on a
// search page for rescue (the Mac's RescueProbe harvest script, word for word).

export interface HarvestedLink {
  href: string;
  text: string;
  context: string;
}

/** Every link on the page with the words that describe it (RescueProbe.harvest). */
export function harvestLinks(doc: Document = document): HarvestedLink[] {
  const out: HarvestedLink[] = [];
  const seen = new Set<string>();
  const anchors: HTMLAnchorElement[] = [...doc.querySelectorAll<HTMLAnchorElement>("a[href]")];
  // Pages built from web components keep their results inside shadow roots.
  if (anchors.length < 30) {
    const walk = (root: Document | ShadowRoot, depth: number) => {
      for (const el of root.querySelectorAll("*")) {
        if (!el.shadowRoot) continue;
        anchors.push(...el.shadowRoot.querySelectorAll<HTMLAnchorElement>("a[href]"));
        if (depth < 8) walk(el.shadowRoot, depth + 1);
      }
    };
    walk(doc, 0);
  }
  for (const a of anchors) {
    if (out.length >= 500) break;
    const href = a.href;
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    const img = a.querySelector("img");
    const words = [a.textContent, a.title, a.getAttribute("aria-label"), img && img.alt, img && img.title];
    const card = a.closest('article, li, [class*="card" i], [class*="item" i], [class*="movie" i], [class*="film" i]');
    out.push({
      href,
      text: words.filter(Boolean).join("\n").replace(/[ \t]+/g, " ").trim().slice(0, 300),
      context: card ? (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240) : "",
    });
  }
  return out;
}

export interface ContentHelpers {
  theater(on: boolean): boolean;
  viewport(): { width: number; height: number; dpr: number };
  links(): HarvestedLink[];
}

export function contentHelpers(runTheater: () => void, win: Window = window): ContentHelpers {
  return {
    theater(on) {
      const scope = win as unknown as { __cineonTheater?: { enable(): boolean; clear(): void } };
      if (!on) {
        scope.__cineonTheater?.clear();
        return false;
      }
      if (!scope.__cineonTheater) runTheater();
      return scope.__cineonTheater?.enable() ?? false;
    },
    viewport() {
      return { width: win.innerWidth, height: win.innerHeight, dpr: win.devicePixelRatio || 1 };
    },
    links() {
      return harvestLinks(win.document);
    },
  };
}
