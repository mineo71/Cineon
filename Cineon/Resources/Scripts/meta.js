// Runs in the top frame, in Cineon's private script world.
// Reads what the page says about itself: title, poster, structured data, icon and search form.
(() => {
  if (window.__cineonMeta) return;
  const handlers = window.webkit && window.webkit.messageHandlers;
  if (!handlers || !handlers.cineonMeta) return;

  const content = (selector) => {
    const el = document.querySelector(selector);
    return el ? el.getAttribute('content') || null : null;
  };
  const absolute = (value) => {
    if (!value) return null;
    try { return new URL(value, location.href).href; } catch (_) { return null; }
  };
  const asNumber = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  };
  const yearOf = (value) => {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? parseInt(match[0], 10) : null;
  };

  const flatten = (node, out) => {
    if (!node) return out;
    if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out; }
    if (typeof node === 'object') {
      if (node['@graph']) flatten(node['@graph'], out);
      if (node['@type']) out.push(node);
    }
    return out;
  };

  const linkedData = () => {
    const items = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        flatten(JSON.parse(script.textContent), []).forEach((node) => {
          const rawType = Array.isArray(node['@type']) ? node['@type'].join(' ') : String(node['@type']);
          if (!/movie|series|episode|videoobject|season/i.test(rawType)) return;
          const image = Array.isArray(node.image) ? node.image[0] : node.image;
          const series = node.partOfSeries || node.partOfTVSeries;
          const season = node.partOfSeason;
          items.push({
            type: rawType,
            name: typeof node.name === 'string' ? node.name : null,
            series: series && typeof series.name === 'string' ? series.name : null,
            season: season ? asNumber(season.seasonNumber) : asNumber(node.seasonNumber),
            episode: asNumber(node.episodeNumber),
            year: yearOf(node.datePublished || node.dateCreated || node.startDate),
            image: absolute(typeof image === 'string' ? image : image && image.url),
            description: typeof node.description === 'string' ? node.description.slice(0, 600) : null,
          });
        });
      } catch (_) {}
    });
    return items;
  };

  const bestIcon = () => {
    let best = null;
    let bestSize = -1;
    document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]').forEach((link) => {
      const href = absolute(link.getAttribute('href'));
      if (!href) return;
      const sizes = (link.getAttribute('sizes') || '').match(/(\d+)x\d+/);
      let size = sizes ? parseInt(sizes[1], 10) : 16;
      if (link.rel.includes('apple-touch-icon')) size = Math.max(size, 120);
      if (/\.svg(\?|$)/i.test(href)) size = Math.max(size, 64);
      if (size > bestSize) {
        best = href;
        bestSize = size;
      }
    });
    return best || absolute('/favicon.ico');
  };

  // Learn how this site searches, so "search everywhere" works without any setup.
  const searchTemplate = () => {
    const selector = [
      'input[type="search"]', 'input[name="q"]', 'input[name="s"]', 'input[name="query"]',
      'input[name="keyword"]', 'input[name="keywords"]', 'input[name="search"]', 'input[name="story"]',
      'input[name="term"]', 'input[name="title"]',
      'input[placeholder*="earch" i]', 'input[placeholder*="оиск" i]', 'input[placeholder*="ошук" i]',
    ].join(',');
    const input = document.querySelector(selector);
    if (!input || !input.name) return null;
    const form = input.form;
    if (!form) return null;
    try {
      const url = new URL(form.getAttribute('action') || location.pathname, location.href);
      new FormData(form).forEach((value, key) => {
        if (key !== input.name && typeof value === 'string' && value && value.length < 60) {
          url.searchParams.set(key, value);
        }
      });
      url.searchParams.set(input.name, 'CINEONQUERY');
      return url.href.replace('CINEONQUERY', '%s');
    } catch (_) {
      return null;
    }
  };

  const extract = () => {
    const h1 = document.querySelector('h1');
    try {
      handlers.cineonMeta.postMessage({
        url: location.href,
        title: document.title || '',
        ogTitle: content('meta[property="og:title"], meta[name="og:title"]'),
        ogType: content('meta[property="og:type"]'),
        ogSite: content('meta[property="og:site_name"]'),
        ogImage: absolute(content('meta[property="og:image"], meta[name="og:image"]')),
        ogDescription: content('meta[property="og:description"], meta[name="description"]'),
        twitterTitle: content('meta[name="twitter:title"]'),
        h1: h1 ? h1.textContent.trim().slice(0, 300) : null,
        ld: linkedData(),
        icon: bestIcon(),
        search: searchTemplate(),
      });
    } catch (_) {}
  };

  window.__cineonMeta = { extract, searchTemplate };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', extract, { once: true });
  } else {
    extract();
  }
  window.addEventListener('load', () => setTimeout(extract, 800), { once: true });
})();
