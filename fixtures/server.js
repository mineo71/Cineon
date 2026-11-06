#!/usr/bin/env node
// A fake streaming site for end-to-end tests. It behaves like the real thing: pop-unders on first
// click, invisible overlays, scripted redirects, a player in a cross-origin iframe, messy titles.
//
//   node fixtures/server.js [port]
//
// Serves on 127.0.0.1 and localhost. They count as different sites, so the player page on
// "localhost" is a real cross-origin iframe inside a page on "127.0.0.1".
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8765);
const VIDEO = path.join(__dirname, 'film.mp4');

// Set by the test through /kill, to make a working site die while it's being used.
const deadHosts = new Set();
const deadPaths = new Set();

const page = (head, body) => `<!doctype html><html><head><meta charset="utf-8">${head}
<style>body{margin:0;background:#111;color:#ddd;font:14px sans-serif}h1{padding:12px;margin:0}
.player{width:800px;height:450px;margin:12px;background:#000}iframe,video{width:100%;height:100%;border:0;display:block}</style>
</head><body>${body}</body></html>`;

const trapScript = `
<script>
  // Trap 1: an invisible layer over everything that opens an ad on first click.
  const trap = document.createElement('div');
  trap.id = 'x8f3k';
  trap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:transparent;';
  trap.onclick = () => { window.__trapFired = (window.__trapFired||0)+1; window.open('http://ads.example.test/popunder'); };
  document.body.appendChild(trap);

  // Trap 2: first click anywhere tries to open a pop-up.
  document.addEventListener('click', () => {
    window.__docClicks = (window.__docClicks||0)+1;
    window.open('http://ads.example.test/landing');
  });
</script>`;

const routes = {
  // Film: messy title, og tags, player in a cross-origin iframe, ad traps on the page.
  '/watch/dune-part-two-2024': () => page(
    `<title>Watch Dune: Part Two (2024) Full Movie Online Free HD | FlixDemo</title>
     <meta property="og:title" content="Dune: Part Two (2024) - Watch Online Free">
     <meta property="og:type" content="video.movie">
     <meta property="og:site_name" content="FlixDemo">
     <meta property="og:image" content="http://127.0.0.1:${PORT}/poster.svg">`,
    `<h1>Dune: Part Two</h1>
     <div class="player"><iframe id="frame" src="http://localhost:${PORT}/player?v=1" allowfullscreen></iframe></div>
     <img id="adimg" src="https://popads.net/banner.gif" width="1" height="1">
     <div class="ad-overlay" id="cosmetic" style="width:50px;height:50px">AD</div>
     ${trapScript}`
  ),

  // Structured data rather than meta tags.
  '/tv/the-bear/episode': () => page(
    `<title>Some junk title | SiteName</title>
     <script type="application/ld+json">${JSON.stringify({
       '@context': 'https://schema.org', '@type': 'TVEpisode', name: 'Forks', episodeNumber: 7,
       partOfSeason: { '@type': 'TVSeason', seasonNumber: 2 },
       partOfSeries: { '@type': 'TVSeries', name: 'The Bear' }, datePublished: '2023-06-22',
     })}</script>`,
    `<h1>The Bear</h1><div class="player"><video id="v" src="/film.mp4" controls crossorigin="anonymous"></video></div>`
  ),

  // Player in an iframe, with video from a third origin and no CORS: frames can't be read.
  '/tainted': () => page(`<title>Tainted Video (2020) | Demo</title>`,
    `<div class="player"><iframe src="http://localhost:${PORT}/player-tainted" allowfullscreen></iframe></div>`),

  // Laid out like HDRezka: the dub is in the title, and the episode is only in the fragment.
  // Its episode list swaps the video without leaving the page.
  '/series/drama/1-mentalist-2008.html': () => page(
    `<title>Смотреть Менталист в озвучке Дубляж онлайн бесплатно в хорошем качестве</title>`,
    `<h1>Менталист</h1><div class="player"><video id="v" src="/film.mp4" controls crossorigin="anonymous"></video></div>
     <ul>${[5, 6, 7].map((e) => `<li class="ep" data-season_id="3" data-episode_id="${e}">Серия ${e}</li>`).join('')}</ul>
     <script>
       document.querySelectorAll('.ep').forEach((li) => li.addEventListener('click', () => {
         location.hash = 't:238-s:' + li.dataset.season_id + '-e:' + li.dataset.episode_id;
         const v = document.getElementById('v');
         v.src = '/film.mp4?e=' + li.dataset.episode_id;
         v.play();
       }));
     </script>`),

  // Two seasons on one page, also laid out like HDRezka: season tabs, and the second season's
  // episode list already in the page but hidden.
  '/series/drama/2-two-seasons-2019.html': () => page(
    `<title>Смотреть Два сезона в озвучке Дубляж онлайн бесплатно в хорошем качестве</title>`,
    `<h1>Два сезона</h1><div class="player"><video id="v" src="/film.mp4?s=1&e=1" controls crossorigin="anonymous"></video></div>
     <ul id="simple-seasons-tabs">${[1, 2].map((n) => `<li class="b-simple_season__item" data-tab_id="${n}">Сезон ${n}</li>`).join('')}</ul>
     ${[[1, [1, 2]], [2, [1, 2, 3]]].map(([n, list]) => `<ul id="simple-episodes-list-${n}"${n === 1 ? '' : ' style="display:none"'}>${
       list.map((e) => `<li class="ep" data-season_id="${n}" data-episode_id="${e}">Серия ${e}</li>`).join('')}</ul>`).join('')}
     <script>
       document.querySelectorAll('.ep').forEach((li) => li.addEventListener('click', () => {
         location.hash = 't:300-s:' + li.dataset.season_id + '-e:' + li.dataset.episode_id;
         const v = document.getElementById('v');
         v.src = '/film.mp4?s=' + li.dataset.season_id + '&e=' + li.dataset.episode_id;
         v.play();
       }));
     </script>`),

  // The same film at another site, under a slightly different title.
  '/film/dune-part-two': () => page(`<title>Dune: Part Two (2024) | OtherDemo</title>`,
    `<h1>Dune: Part Two</h1><div class="player"><video id="v" src="/film.mp4" controls crossorigin="anonymous"></video></div>`),
  '/film/dune-1984': () => page(`<title>Dune (1984) | OtherDemo</title>`,
    `<h1>Dune</h1><div class="player"><video id="v" src="/film.mp4" controls></video></div>`),

  // A video whose server goes quiet partway through.
  '/stall-film': () => page(`<title>Stall Film (2020) | Demo</title>`,
    `<div class="player"><video id="v" src="/hang.mp4" controls crossorigin="anonymous"></video></div>`),

  // A film that will be taken down.
  '/film/vanishing-film-2020': () => page(`<title>Vanishing Film (2020) | Demo</title>`,
    `<div class="player"><video id="v" src="/film.mp4" controls crossorigin="anonymous"></video></div>`),
  '/film/vanishing-film-elsewhere': () => page(`<title>Vanishing Film (2020) | OtherDemo</title>`,
    `<div class="player"><video id="v" src="/film.mp4" controls crossorigin="anonymous"></video></div>`),

  // A player built from web components, with the video two shadow roots deep.
  '/shadow': () => page(`<title>Shadow Player Film (2021) | Demo</title>`,
    `<shadow-outer></shadow-outer>
     <script>
       customElements.define('shadow-inner', class extends HTMLElement {
         connectedCallback() {
           this.attachShadow({ mode: 'open' }).innerHTML =
             '<div class="player"><video id="v" src="/film.mp4" style="width:800px;height:450px" controls></video></div>';
         }
       });
       customElements.define('shadow-outer', class extends HTMLElement {
         connectedCallback() {
           this.attachShadow({ mode: 'open' }).innerHTML = '<shadow-inner></shadow-inner>';
         }
       });
     </script>`),

  // A short clip. It must never be tracked as a film.
  '/clip': () => page(`<title>Trailer | Demo</title>`,
    `<div class="player"><video id="v" src="/short.mp4" controls></video></div>`),

  // A long, silent autoplay banner on a site's home page. Nobody is watching this.
  '/hero': () => page(`<title>Hero Banner Trailer | Demo</title>`,
    `<div class="player"><video id="v" src="/film.mp4" autoplay muted loop playsinline></video></div>`),

  // Tries to send the whole page to another site, shortly after it loads.
  '/redirector': () => page(`<title>Redirector</title>`,
    `<h1>Redirector</h1><script>setTimeout(()=>{ location.href='http://ads.example.test/landing' }, 300)</script>`),

  // Pushes a fake download.
  '/download-trap': () => page(`<title>Download trap</title>`,
    `<script>setTimeout(()=>{ location.href='/player-update.dmg' }, 300)</script>`),

  // A legitimate same-site link, which must keep working.
  '/same-site': () => page(`<title>Same site</title>`,
    `<a id="next" href="/same-site-2">Next</a><a id="blank" href="/same-site-2" target="_blank">New tab</a>`),
  '/same-site-2': () => page(`<title>Same site two</title>`, `<h1>Second page</h1>`),

  // Site search, for "search everywhere".
  '/search': (url) => {
    const q = String(url.searchParams.get('q'));
    const results = [];
    if (/dune/i.test(q)) {
      results.push(
        ['/film/dune-1984', 'Dune (1984)'],
        ['/film/dune-part-two-trailer', 'Dune: Part Two | Official Trailer (2024)'],
        ['/film/dune-part-two', 'Dune: Part Two (2024)'],
      );
    }
    if (/vanishing/i.test(q)) results.push(['/film/vanishing-film-elsewhere', 'Vanishing Film (2020)']);
    return page(`<title>Search</title>`,
      `<h1 id="result">Results for ${q.replace(/[<>&]/g, '')}</h1>
       <a href="/">Home</a><a href="http://ads.example.test/dune-part-two">Dune: Part Two (2024)</a>
       <ul>${results.map(([href, text]) => `<li><a href="${href}">${text}</a></li>`).join('')}</ul>`);
  },
  '/': () => page(`<title>FlixDemo</title><link rel="icon" href="/icon.svg">`,
    `<h1>FlixDemo</h1><form action="/search"><input type="search" name="q"></form>`),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (type, body) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };

  if (url.pathname === '/kill') {
    if (url.searchParams.get('host')) deadHosts.add(url.searchParams.get('host'));
    if (url.searchParams.get('path')) deadPaths.add(url.searchParams.get('path'));
    return send('text/plain', 'ok');
  }
  // A dead host: the connection is dropped before anything comes back.
  if ([...deadHosts].some((host) => req.headers.host.startsWith(host))) return req.socket.destroy();
  if (deadPaths.has(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return res.end(page(`<title>Not found</title>`, `<h1>This film has been removed</h1>`));
  }

  // Episodes of a series, each at its own address.
  const episode = /^\/serial\/rozryv\/2-sezon\/(\d+)-seriya$/.exec(url.pathname);
  if (episode) {
    const number = Number(episode[1]);
    if (number > 6) { res.writeHead(404); return res.end('no such episode'); }
    return send('text/html', page(
      `<title>Розрив 2 сезон ${number} серія дивитися онлайн українською | UASerial</title>
       <meta property="og:site_name" content="UASerial">`,
      `<h1>Розрив 2 сезон ${number} серія</h1>
       <div class="player"><video id="v" src="/film.mp4?e=${number}" controls crossorigin="anonymous"></video></div>
       <form action="/search"><input type="search" name="q"></form>`
    ));
  }

  // Sends the start of the video, then goes quiet with the connection left open. Jumping past
  // what arrived leaves the player waiting for data that never comes.
  if (url.pathname === '/hang.mp4') {
    const { size } = fs.statSync(VIDEO);
    const match = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const start = match ? Number(match[1] || 0) : 0;
    const end = match && match[2] ? Number(match[2]) : size - 1;
    const limit = start === 0 ? 1500000 : 0;
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const length = end - start + 1;
    res.writeHead(match ? 206 : 200, {
      ...headers, 'Content-Length': length, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    // Small requests, such as the player's first probe, are answered in full.
    if (length <= limit) return fs.createReadStream(VIDEO, { start, end }).pipe(res);
    if (limit > 0) fs.createReadStream(VIDEO, { start, end: start + limit - 1 }).pipe(res, { end: false });
    return undefined;
  }

  if (url.pathname === '/player') {
    return send('text/html', page(`<title>player</title>`,
      `<video id="v" src="/film.mp4" controls playsinline style="width:100vw;height:100vh"></video>`));
  }
  if (url.pathname === '/player-tainted') {
    return send('text/html', page(`<title>player</title>`,
      `<video id="v" src="http://127.0.0.1:${PORT}/film.mp4" controls playsinline style="width:100vw;height:100vh"></video>`));
  }
  if (url.pathname === '/film.mp4' || url.pathname === '/short.mp4') {
    const file = url.pathname === '/film.mp4' ? VIDEO : path.join(__dirname, 'short.mp4');
    const { size } = fs.statSync(file);
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const match = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (match) {
      const start = Number(match[1] || 0);
      const end = match[2] ? Number(match[2]) : size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    return fs.createReadStream(file).pipe(res);
  }
  // Laid out like HDRezka's player: the video plays from a media source, and what the Network tab
  // shows is "<file>.mp4:hls:..." requests. The CDN only answers the page's own visitors.
  if (url.pathname === '/rezka/film/1-test-movie-2021.html') {
    return send('text/html', page(
      `<title>Смотреть Тестовый фильм / Test Movie (2021) онлайн бесплатно в хорошем качестве</title>
       <meta property="og:title" content="Тестовый фильм / Test Movie (2021)">`,
      `<h1>Тестовый фильм</h1><div class="player"><video id="v" controls>
         <track kind="subtitles" srclang="en" label="English" src="/subs/test-movie.en.vtt">
       </video></div>
       <script>
         document.cookie = 'cdn_token=letmein; path=/';
         const v = document.getElementById('v');
         const ms = new MediaSource();
         v.src = URL.createObjectURL(ms);
         ms.addEventListener('sourceopen', () => {
           ms.duration = 900;
           fetch('/cdn/stream/1080.mp4:hls:manifest.m3u8');
           fetch('/cdn/stream/1080.mp4:hls:seg-1-v1-a1.ts');
           fetch('/cdn/stream/480.mp4:hls:seg-1-v1-a1.ts');
         });
       </script>`
    ));
  }
  if (url.pathname.startsWith('/cdn/stream/')) {
    const cookie = req.headers.cookie || '';
    const referer = req.headers.referer || '';
    if (!cookie.includes('cdn_token=letmein') || !referer.includes('/rezka/')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('forbidden');
    }
    if (url.pathname.includes(':hls:')) return send('application/vnd.apple.mpegurl', '#EXTM3U\n');
    if (!/\/(1080|480)\.mp4$/.test(url.pathname)) { res.writeHead(404); return res.end(); }
    const { size } = fs.statSync(VIDEO);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
    return fs.createReadStream(VIDEO).pipe(res);
  }
  if (url.pathname === '/subs/test-movie.en.vtt') {
    return send('text/vtt', 'WEBVTT\n\n00:00:01.000 --> 00:10:00.000\nHello from subtitles\n');
  }
  // A film that only streams as an HLS playlist.
  if (url.pathname === '/hls-film') {
    return send('text/html', page(`<title>Stream Only Film (2022) | Demo</title>`,
      `<div class="player"><video id="v" src="/hls/index.m3u8" controls playsinline></video></div>`));
  }
  if (url.pathname.startsWith('/hls/')) {
    const file = path.join(__dirname, 'hls', path.basename(url.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Access-Control-Allow-Origin': '*' });
    return fs.createReadStream(file).pipe(res);
  }
  if (url.pathname === '/player-update.dmg') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="player-update.dmg"' });
    return res.end('not a real file');
  }
  if (url.pathname === '/poster.svg' || url.pathname === '/icon.svg') {
    return send('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#c06"/></svg>');
  }
  const route = routes[url.pathname];
  if (route) return send('text/html', route(url));
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log(`fixture site on http://127.0.0.1:${PORT}`));
