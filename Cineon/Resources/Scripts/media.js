// Runs in every frame, in Cineon's private script world. The page can't see or tamper with it.
// Watches <video> elements and reports playback to the app.
(() => {
  if (window.__cineon) return;
  const handlers = window.webkit && window.webkit.messageHandlers;
  if (!handlers || !handlers.cineonMedia) return;

  const isTop = window === window.top;
  const seen = new WeakSet();
  const asked = new WeakMap();
  const lastTick = new WeakMap();
  const lastTime = new WeakMap();
  const lastProgress = new WeakMap();
  const stalled = new WeakSet();
  let ambientTimer = null;
  let ambientCtx = null;

  // Has anyone touched this frame? Separates a film someone started from a silent banner.
  let userActed = false;
  let lastGesture = 0;
  let lastPointerMove = 0;
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, () => { userActed = true; lastGesture = Date.now(); }, { capture: true, passive: true });
  }
  window.addEventListener('pointermove', () => { lastPointerMove = Date.now(); }, { capture: true, passive: true });

  const post = (message) => {
    try { handlers.cineonMedia.postMessage(message); } catch (_) {}
  };

  const snapshot = (video, type) => {
    const rect = video.getBoundingClientRect();
    return {
      type,
      t: video.currentTime || 0,
      d: Number.isFinite(video.duration) ? video.duration : 0,
      paused: video.paused,
      muted: video.muted || video.volume === 0,
      rate: video.playbackRate || 1,
      w: video.videoWidth || 0,
      h: video.videoHeight || 0,
      cw: Math.round(rect.width),
      ch: Math.round(rect.height),
      top: isTop,
      frame: location.href,
      active: userActed,
    };
  };

  // Ads and previews are short. A film or episode is at least this many seconds.
  const LONG_ENOUGH = 240;
  const isLong = (video) => Number.isFinite(video.duration) && video.duration >= LONG_ENOUGH;

  // Jumps Cineon makes itself must not look like the person skipping something.
  let ownSeekUntil = 0;
  const seekTo = (video, t) => {
    ownSeekUntil = Date.now() + 1000;
    video.currentTime = t;
  };

  // Spans of the video to jump over, learned from earlier episodes.
  let skips = [];
  let lastHandSeek = 0;
  const applySkips = (video) => {
    if (!skips.length || !isLong(video) || video.seeking) return;
    // Someone who just jumped here by hand wants to be here, even if it's the intro.
    if (Date.now() - lastHandSeek < 3000) return;
    const t = video.currentTime;
    for (const skip of skips) {
      if (skip.doneFor === video.currentSrc) continue;
      // Only on arriving at the start by playing, never after someone jumped back to watch it.
      if (t >= skip.from && t < skip.from + 5 && skip.to > t && skip.to < video.duration) {
        skip.doneFor = video.currentSrc;
        seekTo(video, skip.to);
        post({ type: 'skipped', kind: skip.kind, from: skip.from, to: skip.to });
        return;
      }
    }
  };

  const askResume = (video) => {
    if (!isLong(video)) return;
    if (asked.get(video) === video.currentSrc) return;
    asked.set(video, video.currentSrc);
    if (!handlers.cineonMediaReply) return;
    let result;
    try {
      result = handlers.cineonMediaReply.postMessage(snapshot(video, 'ready'));
    } catch (_) {
      return;
    }
    Promise.resolve(result).then((reply) => {
      if (!reply) return;
      if (Array.isArray(reply.skips)) skips = reply.skips;
      if (typeof reply.seekTo === 'number' && reply.seekTo > 0 && reply.seekTo < video.duration) {
        seekTo(video, reply.seekTo);
      }
      if (reply.play && video.paused) video.play().catch(() => {});
    }).catch(() => {});
  };

  // A seek someone made by hand, which may be them skipping an intro.
  let lastSeekAt = 0;
  const noteSeek = (video) => {
    lastSeekAt = Date.now();
    const from = lastTime.get(video);
    const to = video.currentTime;
    lastProgress.set(video, Date.now());
    stalled.delete(video);
    if (from === undefined) { lastTime.set(video, to); return; }
    lastTime.set(video, to);
    if (Date.now() < ownSeekUntil || Date.now() - lastGesture > 1500 || !isLong(video)) return;
    lastHandSeek = Date.now();
    post({ ...snapshot(video, 'jump'), from, to });
  };

  // How long a playing video may stand still before it counts as stuck.
  let stallSeconds = 30;
  let current = null;
  let stallTimer = null;
  const checkStall = () => {
    const video = current;
    if (!video || video.paused || video.ended || !isLong(video) || stalled.has(video) || !navigator.onLine) return;
    const since = lastProgress.get(video);
    if (since && Date.now() - since >= stallSeconds * 1000) {
      stalled.add(video);
      post(snapshot(video, 'stalled'));
    }
  };

  const nowPlaying = (video) => {
    current = video;
    if (!lastProgress.has(video)) lastProgress.set(video, Date.now());
    if (!stallTimer) stallTimer = setInterval(checkStall, 2000);
  };

  const attach = (video) => {
    if (seen.has(video)) return;
    seen.add(video);
    video.addEventListener('loadstart', () => { lastLoadStart = Date.now(); noteElementSources(video); });
    video.addEventListener('loadedmetadata', () => { askResume(video); post(snapshot(video, 'meta')); queueSources(); });
    video.addEventListener('durationchange', () => { askResume(video); queueSources(); });
    video.addEventListener('play', () => { askResume(video); nowPlaying(video); post(snapshot(video, 'play')); queueSources(); });
    video.addEventListener('playing', () => {
      nowPlaying(video);
      lastProgress.set(video, Date.now());
      post(snapshot(video, 'play'));
    });
    video.addEventListener('pause', () => post(snapshot(video, 'pause')));
    video.addEventListener('seeking', () => noteSeek(video));
    video.addEventListener('seeked', () => post(snapshot(video, 'tick')));
    video.addEventListener('ended', () => post(snapshot(video, 'ended')));
    video.addEventListener('timeupdate', () => {
      if (!video.seeking && video.currentTime !== lastTime.get(video)) {
        lastTime.set(video, video.currentTime);
        lastProgress.set(video, Date.now());
        if (stalled.delete(video)) post(snapshot(video, 'recovered'));
      }
      applySkips(video);
      const now = Date.now();
      if (now - (lastTick.get(video) || 0) < 2000) return;
      lastTick.set(video, now);
      post(snapshot(video, 'tick'));
      queueSources();
    });
    // Players often recover by themselves, by switching server, so give them a moment.
    video.addEventListener('error', () => {
      if (!isLong(video) && lastTime.get(video) === undefined) return;
      const at = video.currentTime;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      setTimeout(() => {
        if (video.error && video.currentTime <= at + 1) {
          post({ ...snapshot(video, 'failed'), t: at, d: duration });
        }
      }, 6000);
    });
    if (video.readyState >= 1) { askResume(video); queueSources(); }
    if (!video.paused) { nowPlaying(video); post(snapshot(video, 'play')); }
  };

  // Players built as web components hide their video inside shadow roots, often several deep.
  const collectDeep = (root, into, depth) => {
    root.querySelectorAll('video').forEach((v) => into.push(v));
    if (depth >= 8) return into;
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collectDeep(el.shadowRoot, into, depth + 1);
    });
    return into;
  };

  const scan = () => {
    let videos = [...document.querySelectorAll('video')];
    if (!videos.length) videos = collectDeep(document, [], 0);
    videos.forEach(attach);
    return videos;
  };

  const primary = () => {
    let best = null;
    let bestScore = -1;
    for (const video of scan()) {
      const rect = video.getBoundingClientRect();
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const score = rect.width * rect.height + duration * 100 + (video.paused ? 0 : 1e7);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
  };

  let scanQueued = false;
  const queueScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; scan(); }, 400);
  };

  const start = () => {
    scan();
    const target = document.documentElement || document;
    new MutationObserver(queueScan).observe(target, { childList: true, subtree: true });
    // Many players only create their video once you press play.
    window.addEventListener('pointerdown', () => {
      setTimeout(scan, 500);
      setTimeout(scan, 2000);
    }, { capture: true, passive: true });
    // Catches shadow roots attached later, which a mutation observer can't see into.
    let slowScans = 0;
    const slow = setInterval(() => {
      if (!document.hidden) scan();
      if (++slowScans > 120) clearInterval(slow);
    }, 5000);
  };

  // Files the player asked for, which is what someone would dig out of the Network tab by hand.
  // The page's resource timeline lists every fetch it made, and any script world can read it,
  // so a player can't hide them inside its own code.
  const sources = new Map();
  let sourcesSent = '';
  let sourcesTimer = null;
  // When the player last loaded a new video. Files found around then belong to what's on now.
  let lastLoadStart = 0;
  const isCurrent = (found) => found.at >= lastLoadStart - 10000;
  const SEGMENT = /(?:^|[\/_.-])(?:seg|segment|chunk|frag|fragment|part)[-_]?\d+\.(?:mp4|m4s)(?=[?#]|$)/i;
  // HDRezka's player asks for file.mp4:hls:seg-1-v1-a1.ts. Cutting ":hls:..." leaves the whole film.
  const progressive = (url) => {
    const at = url.search(/\.mp4:hls:/i);
    if (at === -1) return url;
    const rest = url.slice(at + 4);
    const query = rest.search(/[?#]/);
    return url.slice(0, at + 4) + (query === -1 ? '' : rest.slice(query));
  };
  const sourceKind = (url) => {
    if (/\.(?:vtt|srt)(?=[?#]|$)/i.test(url)) return 'subtitle';
    if (/\.m3u8(?=[?#]|$)/i.test(url)) return 'hls';
    if (/\.(?:mp4|m4v|webm|mov)(?=[?#]|$)/i.test(url) && !SEGMENT.test(url)) return 'file';
    return null;
  };
  const noteSource = (raw) => {
    if (!raw || typeof raw !== 'string' || !/^https?:/i.test(raw)) return;
    const url = progressive(raw);
    const kind = sourceKind(url);
    if (!kind) return;
    const known = sources.get(url);
    if (known && isCurrent(known)) return;
    sources.delete(url);
    sources.set(url, { kind, at: Date.now() });
    if (sources.size > 60) sources.delete(sources.keys().next().value);
    queueSources();
  };
  const noteElementSources = (video) => {
    noteSource(video.currentSrc);
    video.querySelectorAll('source, track').forEach((el) => noteSource(el.src));
  };
  const queueSources = () => {
    if (sourcesTimer) return;
    sourcesTimer = setTimeout(sendSources, 500);
  };
  // Only a frame holding a film reports, which leaves out ads, trailers and previews in other frames.
  const sendSources = () => {
    sourcesTimer = null;
    const video = primary();
    if (!video || !isLong(video)) return;
    noteElementSources(video);
    const items = [...sources].map(([url, s]) => ({ url, kind: s.kind, at: s.at, current: isCurrent(s) }));
    if (!items.length) return;
    const key = items.map((i) => `${i.url}${i.current ? '+' : ''}`).join('\n') + (video.currentSrc || '');
    if (key === sourcesSent) return;
    sourcesSent = key;
    post({ ...snapshot(video, 'sources'), items, src: video.currentSrc || '', pageTitle: document.title });
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) noteSource(entry.name);
    }).observe({ type: 'resource', buffered: true });
  } catch (_) {}

  // Ambient light: read a tiny copy of the current frame. Cross-origin video without CORS taints
  // the canvas and reading throws, in which case the app falls back to the poster's colours.
  const sampleAmbient = () => {
    const video = primary();
    if (!video || video.paused || document.hidden || !video.videoWidth) return;
    try {
      if (!ambientCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = 6;
        canvas.height = 4;
        ambientCtx = canvas.getContext('2d', { willReadFrequently: true });
      }
      ambientCtx.drawImage(video, 0, 0, 6, 4);
      const data = ambientCtx.getImageData(0, 0, 6, 4).data;
      const zones = [];
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          let r = 0, g = 0, b = 0;
          for (let y = row * 2; y < row * 2 + 2; y++) {
            for (let x = col * 2; x < col * 2 + 2; x++) {
              const i = (y * 6 + x) * 4;
              r += data[i];
              g += data[i + 1];
              b += data[i + 2];
            }
          }
          zones.push([Math.round(r / 4), Math.round(g / 4), Math.round(b / 4)]);
        }
      }
      post({ type: 'ambient', zones });
    } catch (_) {
      post({ type: 'ambientUnavailable' });
      clearInterval(ambientTimer);
      ambientTimer = null;
    }
  };

  // A small card over the player. It lives in the page rather than in the app's window because
  // that's the only way it can still be seen in fullscreen. Styles are set from script, since a
  // site's content security policy can forbid style elements but not this.
  const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let bannerHost = null;
  let bannerID = null;
  let bannerTimers = [];

  const clearBanner = (id) => {
    if (id && id !== bannerID) return;
    bannerTimers.forEach(clearTimeout);
    bannerTimers = [];
    bannerID = null;
    if (bannerHost) bannerHost.remove();
    bannerHost = null;
  };

  const placeBanner = () => {
    if (!bannerHost) return;
    const full = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = full && full.tagName !== 'VIDEO' ? full : document.documentElement;
    if (bannerHost.parentNode !== parent) parent.appendChild(bannerHost);
    const video = current || primary();
    const rect = video ? video.getBoundingClientRect() : null;
    const right = rect ? Math.max(16, window.innerWidth - rect.right + 18) : 16;
    const bottom = rect ? Math.max(16, window.innerHeight - rect.bottom + 64) : 64;
    bannerHost.style.right = `${right}px`;
    bannerHost.style.bottom = `${bottom}px`;
  };

  const showBanner = (options) => {
    clearBanner();
    const host = document.createElement('cineon-banner');
    Object.assign(host.style, { all: 'initial', position: 'fixed', zIndex: '2147483647', display: 'block' });
    const root = host.attachShadow({ mode: 'closed' });
    // The click belongs to the card. It must not also pause the film underneath.
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }

    const card = document.createElement('div');
    Object.assign(card.style, {
      display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 9px 8px 15px', borderRadius: '14px', color: '#fff',
      background: 'rgba(16,16,16,.72)', webkitBackdropFilter: 'blur(22px) saturate(1.5)', backdropFilter: 'blur(22px) saturate(1.5)',
      border: '.5px solid rgba(255,255,255,.2)', boxShadow: '0 10px 34px rgba(0,0,0,.45)',
      font: '500 13px/1.3 -apple-system, BlinkMacSystemFont, sans-serif', maxWidth: '440px',
    });

    const text = document.createElement('span');
    text.textContent = options.text;
    card.appendChild(text);

    const act = (id) => {
      clearBanner();
      post({ type: 'banner', banner: options.id, action: id });
    };

    for (const action of options.actions || []) {
      const button = document.createElement('button');
      Object.assign(button.style, {
        position: 'relative', overflow: 'hidden', border: '0', borderRadius: '9px', padding: '5px 12px', cursor: 'pointer',
        font: '600 12.5px/1.3 -apple-system, BlinkMacSystemFont, sans-serif', whiteSpace: 'nowrap',
        background: action.primary ? '#f2f2f2' : 'transparent', color: action.primary ? '#000' : 'rgba(255,255,255,.72)',
      });
      const label = document.createElement('span');
      label.textContent = action.label;
      Object.assign(label.style, { position: 'relative' });
      if (action.primary && options.seconds && !reducedMotion()) {
        // The button fills up as the time runs out.
        const fill = document.createElement('span');
        Object.assign(fill.style, { position: 'absolute', inset: '0', background: '#bdbdbd', transformOrigin: 'left' });
        button.appendChild(fill);
        fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: options.seconds * 1000, fill: 'forwards' });
      }
      button.appendChild(label);
      button.addEventListener('click', () => act(action.id));
      card.appendChild(button);
    }

    root.appendChild(card);
    bannerHost = host;
    bannerID = options.id;
    placeBanner();
    if (!reducedMotion()) {
      card.animate(
        [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    }
    if (options.seconds && options.onExpire) {
      bannerTimers.push(setTimeout(() => act(options.onExpire), options.seconds * 1000));
    } else if (options.timeout) {
      bannerTimers.push(setTimeout(() => clearBanner(options.id), options.timeout * 1000));
    }
  };

  document.addEventListener('fullscreenchange', placeBanner);
  document.addEventListener('webkitfullscreenchange', placeBanner);

  // The download button: a quiet pill in the player's top corner. It shows while the mouse moves,
  // like the player's own controls, and stays while a download runs.
  let pillHost = null;
  let pillButton = null;
  let pillLabel = null;
  let pillFill = null;
  let pillTimer = null;
  let pillOptions = null;

  const placePill = () => {
    if (!pillHost) return;
    const full = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = full && full.tagName !== 'VIDEO' ? full : document.documentElement;
    if (pillHost.parentNode !== parent) parent.appendChild(pillHost);
    const video = current || primary();
    if (!video) { pillHost.style.display = 'none'; return; }
    const rect = video.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 120) { pillHost.style.display = 'none'; return; }
    pillHost.style.display = 'block';
    pillHost.style.top = `${Math.max(8, rect.top + 14)}px`;
    pillHost.style.right = `${Math.max(8, window.innerWidth - rect.right + 14)}px`;
    const awake = Date.now() - lastPointerMove < 2500 || pillOptions.busy || pillHost.matches(':hover');
    pillButton.style.opacity = awake ? '1' : '0';
    pillButton.style.pointerEvents = awake ? 'auto' : 'none';
  };

  const clearPill = () => {
    if (pillTimer) clearInterval(pillTimer);
    pillTimer = null;
    if (pillHost) pillHost.remove();
    pillHost = pillButton = pillLabel = pillFill = pillOptions = null;
  };

  const showPill = (options) => {
    if (!options) { clearPill(); return; }
    pillOptions = options;
    if (!pillHost) {
      const host = document.createElement('cineon-download');
      Object.assign(host.style, { all: 'initial', position: 'fixed', zIndex: '2147483646', display: 'block' });
      const root = host.attachShadow({ mode: 'closed' });
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) {
        host.addEventListener(type, (event) => event.stopPropagation());
      }
      const button = document.createElement('button');
      Object.assign(button.style, {
        position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', gap: '6px',
        border: '.5px solid rgba(255,255,255,.22)', borderRadius: '999px', padding: '6px 12px 6px 10px', cursor: 'pointer',
        color: '#fff', background: 'rgba(16,16,16,.62)', webkitBackdropFilter: 'blur(18px) saturate(1.4)',
        backdropFilter: 'blur(18px) saturate(1.4)', boxShadow: '0 6px 22px rgba(0,0,0,.35)',
        font: '600 12px/1.2 -apple-system, BlinkMacSystemFont, sans-serif', whiteSpace: 'nowrap',
        transition: reducedMotion() ? 'none' : 'opacity .25s ease',
      });
      const fill = document.createElement('span');
      Object.assign(fill.style, {
        position: 'absolute', left: '0', top: '0', bottom: '0', width: '0%', background: 'rgba(255,255,255,.18)',
        transition: reducedMotion() ? 'none' : 'width .4s ease',
      });
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.setAttribute('width', '13');
      icon.setAttribute('height', '13');
      Object.assign(icon.style, { position: 'relative', flex: 'none' });
      icon.innerHTML = '<path d="M8 2v8.2M4.6 7.2 8 10.6l3.4-3.4M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
      const label = document.createElement('span');
      Object.assign(label.style, { position: 'relative' });
      button.append(fill, icon, label);
      button.addEventListener('click', () => post({ type: 'download', action: pillOptions && pillOptions.action }));
      root.appendChild(button);
      pillHost = host;
      pillButton = button;
      pillLabel = label;
      pillFill = fill;
      pillTimer = setInterval(placePill, 400);
    }
    pillLabel.textContent = options.label;
    pillButton.title = options.hint || '';
    pillFill.style.width = `${Math.round((options.progress || 0) * 100)}%`;
    placePill();
  };

  // Caption style for players that use the browser's own text tracks.
  let captionStyle = null;
  const setCaptions = (css) => {
    if (captionStyle) captionStyle.remove();
    captionStyle = null;
    if (!css) return;
    try {
      const style = document.createElement('style');
      style.textContent = `video::cue { ${css} }`;
      (document.head || document.documentElement).appendChild(style);
      captionStyle = style;
    } catch (_) {}
  };

  // Where the picture sits inside the video element, without any letterboxing around it.
  const pictureRect = (video) => {
    const rect = video.getBoundingClientRect();
    if (!video.videoWidth || !video.videoHeight) return rect;
    const style = getComputedStyle(video).objectFit;
    if (style === 'fill' || style === 'cover') return rect;
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2,
      width,
      height,
    };
  };

  // Voice boost: dialogue up, rumble and explosions down. Web Audio can only hear a video whose
  // sound the page is allowed to read. Routing any other video through it silences the film, so
  // those are left alone. MediaSource players (blob: addresses) built their stream from data the
  // page fetched itself, and are fine.
  let boostWanted = false;
  let boostCtx = null;
  let boostWaiting = false;
  const boostGraphs = new WeakMap();
  const canBoost = (video) => {
    const src = video.currentSrc || '';
    if (!src) return false;
    if (src.startsWith('blob:') || src.startsWith('data:')) return true;
    if (video.crossOrigin === 'anonymous' || video.crossOrigin === 'use-credentials') return true;
    try { return new URL(src, location.href).origin === location.origin; } catch (_) { return false; }
  };
  const reportBoost = (state) => post({ type: 'boost', state });
  const boostChain = (ctx) => {
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 160; low.gain.value = -5;
    const voice = ctx.createBiquadFilter();
    voice.type = 'peaking'; voice.frequency.value = 2600; voice.Q.value = 0.9; voice.gain.value = 6;
    const air = ctx.createBiquadFilter();
    air.type = 'peaking'; air.frequency.value = 1100; air.Q.value = 1.1; air.gain.value = 2.5;
    const squash = ctx.createDynamicsCompressor();
    squash.threshold.value = -30; squash.knee.value = 12; squash.ratio.value = 5; squash.attack.value = 0.004; squash.release.value = 0.22;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.9;
    low.connect(voice); voice.connect(air); air.connect(squash); squash.connect(makeup);
    return { input: low, output: makeup };
  };
  // The graph for one video: source -> (boost chain or nothing) -> level -> meter -> speakers.
  const wire = (video, on) => {
    let graph = boostGraphs.get(video);
    if (!graph) {
      const source = boostCtx.createMediaElementSource(video);
      const level = boostCtx.createGain();
      const meter = boostCtx.createAnalyser();
      meter.fftSize = 1024;
      level.connect(meter);
      meter.connect(boostCtx.destination);
      graph = { source, level, meter, chain: boostChain(boostCtx), on: null };
      graph.chain.output.connect(level);
      boostGraphs.set(video, graph);
    }
    if (graph.on === on) return graph;
    try { graph.source.disconnect(); } catch (_) {}
    graph.source.connect(on ? graph.chain.input : graph.level);
    graph.on = on;
    return graph;
  };
  const applyBoost = async () => {
    const video = current || primary();
    if (!video || !isLong(video)) return;
    const graph = boostGraphs.get(video);
    if (!boostWanted) {
      // A video that went through Web Audio once stays there, so it carries on without the boost.
      if (graph) wire(video, false);
      reportBoost('off');
      return;
    }
    if (!graph && !canBoost(video)) { reportBoost('unsupported'); return; }
    try {
      if (!boostCtx) boostCtx = new AudioContext();
      if (boostCtx.state !== 'running') await boostCtx.resume().catch(() => {});
    } catch (_) { reportBoost('unsupported'); return; }
    // Only once the sound can actually come out of it, so turning this on never silences a film.
    if (boostCtx.state !== 'running') {
      if (!boostWaiting) {
        boostWaiting = true;
        window.addEventListener('pointerdown', () => { boostWaiting = false; applyBoost(); }, { capture: true, once: true });
      }
      reportBoost('waiting');
      return;
    }
    try { wire(video, true); reportBoost('on'); } catch (_) { reportBoost('unsupported'); }
  };
  const boostLevel = () => {
    const video = current || primary();
    const graph = video && boostGraphs.get(video);
    if (!graph) return -1;
    const data = new Float32Array(graph.meter.fftSize);
    graph.meter.getFloatTimeDomainData(data);
    let sum = 0;
    for (const x of data) sum += x * x;
    return Math.sqrt(sum / data.length);
  };

  // Sleep timer: the sound fades away, the film pauses, and the volume goes back to where it was
  // so the next play isn't silent.
  let fade = null;
  const setLevel = (video, x) => {
    const graph = boostGraphs.get(video);
    if (graph) graph.level.gain.value = x;
    else video.volume = Math.max(0, Math.min(1, fade.volume * x));
  };
  const endFade = (pause) => {
    if (!fade) return;
    const { video, volume, timer } = fade;
    clearInterval(timer);
    if (pause && !video.paused) video.pause();
    const graph = boostGraphs.get(video);
    if (graph) graph.level.gain.value = 1;
    else video.volume = volume;
    fade = null;
  };
  const fadeOut = (seconds) => {
    const video = current || primary();
    if (!video) return false;
    endFade(false);
    const started = Date.now();
    const span = Math.max(0.5, seconds) * 1000;
    fade = { video, volume: video.volume, timer: null };
    fade.timer = setInterval(() => {
      const left = 1 - (Date.now() - started) / span;
      if (left <= 0) { endFade(true); post({ ...snapshot(video, 'pause'), sleep: true }); return; }
      setLevel(video, left * left);
    }, 100);
    return true;
  };

  // A second line of subtitles, drawn by Cineon above the picture and kept in time with the video.
  // The cues come from the app, which fetched the file with the page's cookies.
  let subsHost = null;
  let subsText = null;
  let subsCues = [];
  let subsTimer = null;
  let subsShown = '';
  const cueText = (t) => {
    let lo = 0, hi = subsCues.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (subsCues[mid].s <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const lines = [];
    // Cues can overlap. Look back a little for any still showing.
    for (let i = found; i >= 0 && i > found - 6; i--) {
      const cue = subsCues[i];
      if (cue.s <= t && t < cue.e) lines.unshift(cue.t);
    }
    return lines.join('\n');
  };
  const placeSubs = () => {
    if (!subsHost) return;
    const full = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = full && full.tagName !== 'VIDEO' ? full : document.documentElement;
    if (subsHost.parentNode !== parent) parent.appendChild(subsHost);
    const video = current || primary();
    if (!video || !video.videoWidth) { subsHost.style.display = 'none'; return; }
    const rect = pictureRect(video);
    const text = cueText(video.currentTime);
    subsHost.style.display = text ? 'block' : 'none';
    subsHost.style.left = `${rect.left}px`;
    subsHost.style.width = `${rect.width}px`;
    subsHost.style.top = `${rect.top + rect.height * 0.06}px`;
    subsText.style.fontSize = `${Math.max(13, Math.min(40, rect.height * 0.042))}px`;
    if (text !== subsShown) { subsShown = text; subsText.textContent = text; }
  };
  const showSubs = (cues) => {
    if (subsTimer) clearInterval(subsTimer);
    subsTimer = null;
    if (subsHost) subsHost.remove();
    subsHost = subsText = null;
    subsShown = '';
    subsCues = Array.isArray(cues) ? cues.slice().sort((a, b) => a.s - b.s) : [];
    if (!subsCues.length) return;
    const host = document.createElement('cineon-subtitles');
    Object.assign(host.style, { all: 'initial', position: 'fixed', zIndex: '2147483645', display: 'none', pointerEvents: 'none' });
    const root = host.attachShadow({ mode: 'closed' });
    const line = document.createElement('div');
    Object.assign(line.style, {
      margin: '0 auto', width: 'fit-content', maxWidth: '86%', padding: '.18em .55em', borderRadius: '.3em',
      color: '#ffe9a8', background: 'rgba(0,0,0,.6)', textAlign: 'center', whiteSpace: 'pre-line',
      font: '500 20px/1.3 -apple-system, BlinkMacSystemFont, sans-serif', textShadow: '0 1px 2px rgba(0,0,0,.8)',
    });
    root.appendChild(line);
    subsHost = host;
    subsText = line;
    subsTimer = setInterval(placeSubs, 150);
    placeSubs();
  };

  const quietPlay = () => {
    const v = primary();
    if (!v) return false;
    v.volume = 0;
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    return true;
  };
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.cineonHelperPlay !== 1) return;
    for (const f of document.querySelectorAll('iframe')) {
      try { f.contentWindow.postMessage({ cineonHelperPlay: 1 }, '*'); } catch (_) {}
    }
    quietPlay();
  });

  // Episode lists on the page itself, for sites that switch episode without leaving the page.
  const NEXT_WORDS = /next\s*episode|следующ\w*\s*сери|наступн\w*\s*сері/i;
  const episodeElement = (season, episode, isNextInSeason) => {
    const exact = document.querySelector(
      `[data-season_id="${season}"][data-episode_id="${episode}"], [data-season="${season}"][data-episode="${episode}"]`
    );
    if (exact) return exact;
    if (!isNextInSeason) return null;
    const listed = document.querySelectorAll(`[data-episode_id="${episode}"], [data-episode="${episode}"], [data-ep="${episode}"]`);
    if (listed.length === 1) return listed[0];
    for (const el of document.querySelectorAll('a, button, [role="button"]')) {
      const words = [el.getAttribute('aria-label'), el.title, (el.textContent || '').slice(0, 40)].join(' ');
      if (NEXT_WORDS.test(words)) return el;
    }
    return null;
  };

  window.__cineon = {
    pause() { const v = primary(); if (v && !v.paused) v.pause(); },
    play() { const v = primary(); if (v) v.play().catch(() => {}); },
    toggle() { const v = primary(); if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); } },
    seek(t) { const v = primary(); if (v) seekTo(v, t); },
    skip(by) {
      const v = primary();
      if (v) {
        // Asked for from the app's own controls: that counts as the person doing it.
        lastGesture = Date.now();
        v.currentTime = Math.max(0, v.currentTime + by);
      }
    },
    rate(r) { const v = primary(); if (v) v.playbackRate = r; },
    pip() {
      const v = primary();
      if (!v) return;
      if (v.webkitSetPresentationMode) {
        v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } else if (v.requestPictureInPicture) {
        v.requestPictureInPicture().catch(() => {});
      }
    },
    ambient(on) {
      if (on && !ambientTimer) {
        sampleAmbient();
        ambientTimer = setInterval(sampleAmbient, 1500);
      } else if (!on && ambientTimer) {
        clearInterval(ambientTimer);
        ambientTimer = null;
      }
    },
    state() {
      const v = primary();
      return v ? snapshot(v, 'tick') : null;
    },
    setSkips(list) {
      // Keep the record of what already ran, so that a rule arriving twice doesn't run twice.
      const done = new Map(skips.map((s) => [s.kind, s.doneFor]));
      skips = list.map((s) => ({ ...s, doneFor: done.get(s.kind) }));
    },
    setStallSeconds(seconds) { stallSeconds = seconds; },
    banner(options) { showBanner(options); },
    clearBanner(id) { clearBanner(id); },
    downloadPill(options) { showPill(options); },
    captions(css) { setCaptions(css); },
    voiceBoost(on) { boostWanted = !!on; applyBoost(); },
    boostLevel() { return boostLevel(); },
    fadeOut(seconds) { return fadeOut(seconds); },
    cancelFade() { endFade(false); },
    volume() { const v = current || primary(); return v ? v.volume : -1; },
    secondSubtitles(cues) { showSubs(cues); },
    secondSubtitleText() { return subsHost && subsHost.style.display !== 'none' ? subsShown : ''; },
    // For a helper tab that only needs the player to fetch its file. Plays at volume zero rather
    // than muted, since browsers pause muted video nobody can see, and tells every frame below.
    playQuietly() {
      for (const f of document.querySelectorAll('iframe')) {
        try { f.contentWindow.postMessage({ cineonHelperPlay: 1 }, '*'); } catch (_) {}
      }
      return quietPlay();
    },
    // Every season the page lists: in its episode lists, and in its season tabs.
    seasonsOnPage() {
      const found = new Set();
      document.querySelectorAll('[data-season_id][data-episode_id], [data-season][data-episode]').forEach((el) => {
        const n = Number(el.getAttribute('data-season_id') || el.getAttribute('data-season'));
        if (Number.isInteger(n) && n > 0) found.add(n);
      });
      document.querySelectorAll('[id*="season" i] [data-tab_id], [class*="season" i][data-tab_id]').forEach((el) => {
        const n = Number(el.getAttribute('data-tab_id'));
        if (Number.isInteger(n) && n > 0) found.add(n);
      });
      return [...found].sort((a, b) => a - b);
    },
    episodesOnPage(season) {
      const found = new Set();
      document.querySelectorAll(`[data-season_id="${season}"][data-episode_id], [data-season="${season}"][data-episode]`).forEach((el) => {
        const n = Number(el.getAttribute('data-episode_id') || el.getAttribute('data-episode'));
        if (Number.isInteger(n) && n > 0) found.add(n);
      });
      return [...found].sort((a, b) => a - b);
    },
    sources() {
      sourcesSent = '';
      sendSources();
      return [...sources].map(([url, s]) => ({ url, kind: s.kind, current: isCurrent(s) }));
    },
    exitFullscreen() {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    },
    // One frame: the image itself when the browser lets us read it, and where it sits on screen
    // in any case, so that the app can photograph it from outside instead.
    capture(maxWidth, quality) {
      const v = primary();
      if (!v || !v.videoWidth) return null;
      const rect = pictureRect(v);
      const out = {
        x: rect.left, y: rect.top, w: rect.width, h: rect.height, t: v.currentTime,
        d: Number.isFinite(v.duration) ? v.duration : 0,
        paused: v.paused, idle: Date.now() - lastPointerMove, url: location.href,
        // Right after a jump, the old picture or a black one is still showing.
        settled: !v.seeking && v.readyState >= 3 && Date.now() - lastSeekAt > 2000,
      };
      try {
        const scale = Math.min(1, maxWidth / v.videoWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        out.data = canvas.toDataURL('image/jpeg', quality);
      } catch (_) {}
      return out;
    },
    // In the top frame: where the frame holding the video sits on the page.
    frameRect(frameURL, width, height) {
      let best = null;
      let bestScore = -1;
      for (const frame of document.querySelectorAll('iframe')) {
        const rect = frame.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 60) continue;
        let score = (rect.width * rect.height) / 1e6;
        if (frame.src && frameURL && frame.src.split('#')[0] === frameURL.split('#')[0]) score += 1000;
        if (Math.abs(rect.width - width) < 4 && Math.abs(rect.height - height) < 4) score += 100;
        if (score > bestScore) { best = rect; bestScore = score; }
      }
      return best ? { x: best.left, y: best.top, w: best.width, h: best.height } : null;
    },
    flash() {
      if (reducedMotion()) return;
      const v = current || primary();
      if (!v) return;
      const rect = v.getBoundingClientRect();
      const shutter = document.createElement('div');
      Object.assign(shutter.style, {
        position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        background: '#fff', pointerEvents: 'none', zIndex: '2147483646',
      });
      const full = document.fullscreenElement || document.webkitFullscreenElement;
      (full && full.tagName !== 'VIDEO' ? full : document.documentElement).appendChild(shutter);
      shutter.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 240, easing: 'ease-out' }).finished
        .finally(() => shutter.remove());
    },
    hasEpisode(season, episode, isNextInSeason) { return !!episodeElement(season, episode, isNextInSeason); },
    openEpisode(season, episode, isNextInSeason) {
      const element = episodeElement(season, episode, isNextInSeason);
      if (!element) return false;
      element.click();
      return true;
    },
  };

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
