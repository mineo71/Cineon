// SVG stand-ins for the SF Symbols the Mac's screens use, named the same. 24×24, drawn in
// `currentColor`: outlines at 1.8 for the plain symbols, solid fills for `.fill` ones.

import type { CSSProperties, JSX } from "preact";

type Shape = JSX.Element;
const S = { fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;
const F = { fill: "currentColor", stroke: "none" } as const;

const star = "M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z";

const shapes: Record<string, () => Shape> = {
  house: () => <path {...S} d="M3.5 10.5 12 3.5l8.5 7M5.5 9v11h4.8v-6h3.4v6h4.8V9" />,
  "house.fill": () => <path {...F} d="M12 2.8 2.6 10.6a1 1 0 0 0 1.3 1.5l.6-.5V20a1 1 0 0 0 1 1h4v-6.2h5V21h4a1 1 0 0 0 1-1v-8.4l.6.5a1 1 0 0 0 1.3-1.5z" />,
  "film.stack": () => (
    <g {...S}>
      <rect x="4" y="7.5" width="16" height="13" rx="2" />
      <path d="M6.5 4.5h11M8.5 7.5v13M15.5 7.5v13M4 11.5h4.5M4 16.5h4.5M15.5 11.5H20M15.5 16.5H20" />
    </g>
  ),
  "film.stack.fill": () => (
    <g>
      <path {...S} d="M6.5 4.5h11" />
      <path {...F} fill-rule="evenodd" d="M6 6.6h12a2.6 2.6 0 0 1 2.6 2.6v9.2A2.6 2.6 0 0 1 18 21H6a2.6 2.6 0 0 1-2.6-2.6V9.2A2.6 2.6 0 0 1 6 6.6zm-.8 4h2.6V8.4H6c-.4 0-.8.4-.8.8zm0 4.5h2.6v-2.6H5.2zm0 3.3c0 .4.4.8.8.8h1.8V17H5.2zm13.6-7.8V9.2c0-.4-.4-.8-.8-.8h-1.8v2.2zm0 4.5v-2.6h-2.6v2.6zm0 1.9h-2.6v2.2H18c.4 0 .8-.4.8-.8z" />
    </g>
  ),
  clock: () => (
    <g {...S}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7v5.2l3.4 2" />
    </g>
  ),
  "clock.fill": () => <path {...F} d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8zm.9 4.4v4.7l3 1.8a.9.9 0 1 1-.9 1.5l-3.5-2.1a.9.9 0 0 1-.4-.8V7a.9.9 0 1 1 1.8 0z" />,
  "arrow.down.circle": () => (
    <g {...S}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.5v8.5M8.3 12.6 12 16.3l3.7-3.7" />
    </g>
  ),
  "arrow.down.circle.fill": () => <path {...F} d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8zm.9 5v6.6l2.2-2.2a.9.9 0 1 1 1.3 1.3l-3.8 3.7a.9.9 0 0 1-1.2 0l-3.8-3.7a.9.9 0 1 1 1.3-1.3l2.2 2.2V7.6a.9.9 0 1 1 1.8 0z" />,
  "arrow.down.circle.dotted": () => (
    <g {...S}>
      <circle cx="12" cy="12" r="8.6" stroke-dasharray="2 2.6" />
      <path d="M12 7.5v8.5M8.3 12.6 12 16.3l3.7-3.7" />
    </g>
  ),
  "person.2": () => (
    <g {...S}>
      <circle cx="9" cy="8.5" r="3.3" />
      <path d="M3.2 19.5c.4-3.2 2.7-5.2 5.8-5.2s5.4 2 5.8 5.2" />
      <path d="M15.3 5.6a3.2 3.2 0 0 1 0 6.1M17.4 14.6c1.9.6 3.1 2.3 3.4 4.9" />
    </g>
  ),
  "person.2.fill": () => (
    <g {...F}>
      <circle cx="9" cy="8.5" r="3.6" />
      <path d="M2.6 19.6c.4-3.7 3-6 6.4-6s6 2.3 6.4 6a.9.9 0 0 1-.9 1H3.5a.9.9 0 0 1-.9-1z" />
      <path d="M15.6 4.9a3.6 3.6 0 0 1 0 7.2c.7-1 1-2.2 1-3.6s-.3-2.6-1-3.6zM17.2 13.9c2.5.7 4 2.8 4.2 5.7a.9.9 0 0 1-.9 1h-3.4c.2-.3.2-.7.2-1.1-.2-2.3-1-4.2-2.4-5.6.8-.1 1.6 0 2.3 0z" />
    </g>
  ),
  "person.2.wave.2": () => (
    <g {...S}>
      <circle cx="12" cy="9" r="3.1" />
      <path d="M6.8 19.5c.4-3 2.5-4.9 5.2-4.9s4.8 1.9 5.2 4.9M4.6 6.2a8 8 0 0 0 0 7.6M19.4 6.2a8 8 0 0 1 0 7.6M2.3 4.5a11 11 0 0 0 0 11M21.7 4.5a11 11 0 0 1 0 11" />
    </g>
  ),
  globe: () => (
    <g {...S}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.4 12h17.2M12 3.4c2.4 2.4 3.5 5.3 3.5 8.6s-1.1 6.2-3.5 8.6c-2.4-2.4-3.5-5.3-3.5-8.6s1.1-6.2 3.5-8.6z" />
    </g>
  ),
  magnifyingglass: () => (
    <g {...S}>
      <circle cx="10.5" cy="10.5" r="6.3" />
      <path d="m15.2 15.2 5.3 5.3" />
    </g>
  ),
  "square.grid.2x2": () => (
    <g {...S}>
      <rect x="3.8" y="3.8" width="6.8" height="6.8" rx="1.6" />
      <rect x="13.4" y="3.8" width="6.8" height="6.8" rx="1.6" />
      <rect x="3.8" y="13.4" width="6.8" height="6.8" rx="1.6" />
      <rect x="13.4" y="13.4" width="6.8" height="6.8" rx="1.6" />
    </g>
  ),
  "star.fill": () => <path {...F} d={star} />,
  star: () => <path {...S} d={star} />,
  "star.leadinghalf.filled": () => (
    <g>
      <path {...S} d={star} />
      <path {...F} d="M12 2.6v14.4l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" />
    </g>
  ),
  "play.fill": () => <path {...F} d="M7 4.6v14.8a1 1 0 0 0 1.5.9l12-7.4a1 1 0 0 0 0-1.8l-12-7.4A1 1 0 0 0 7 4.6z" />,
  "pause.fill": () => (
    <g {...F}>
      <rect x="5.8" y="4.2" width="4.4" height="15.6" rx="1.2" />
      <rect x="13.8" y="4.2" width="4.4" height="15.6" rx="1.2" />
    </g>
  ),
  "chevron.down": () => <path {...S} stroke-width={2.2} d="m6 9.2 6 6 6-6" />,
  "chevron.up": () => <path {...S} stroke-width={2.2} d="m6 14.8 6-6 6 6" />,
  "chevron.left": () => <path {...S} stroke-width={2.2} d="m14.8 6-6 6 6 6" />,
  "chevron.right": () => <path {...S} stroke-width={2.2} d="m9.2 6 6 6-6 6" />,
  xmark: () => <path {...S} stroke-width={2.1} d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  plus: () => <path {...S} stroke-width={2} d="M12 5v14M5 12h14" />,
  checkmark: () => <path {...S} stroke-width={2.3} d="m5 12.6 4.4 4.4L19 7.4" />,
  "checkmark.circle": () => (
    <g {...S}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m8.2 12.3 2.6 2.6 5-5.2" />
    </g>
  ),
  "checkmark.circle.fill": () => <path {...F} d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8zm4.6 7.1-5.1 5.6a.9.9 0 0 1-1.3 0l-2.8-2.8a.9.9 0 1 1 1.3-1.3l2.1 2.1 4.5-4.9a.9.9 0 1 1 1.3 1.3z" />,
  circle: () => <circle {...S} cx="12" cy="12" r="8.6" />,
  "circle.lefthalf.filled": () => (
    <g>
      <circle {...S} cx="12" cy="12" r="8.6" />
      <path {...F} d="M12 3.4a8.6 8.6 0 0 0 0 17.2z" />
    </g>
  ),
  ellipsis: () => (
    <g {...F}>
      <circle cx="5.5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="18.5" cy="12" r="1.8" />
    </g>
  ),
  "ellipsis.circle": () => (
    <g>
      <circle {...S} cx="12" cy="12" r="8.6" />
      <g {...F}>
        <circle cx="8" cy="12" r="1.3" />
        <circle cx="12" cy="12" r="1.3" />
        <circle cx="16" cy="12" r="1.3" />
      </g>
    </g>
  ),
  "gobackward.10": () => (
    <g>
      <path {...S} d="M6.3 7.2A8.2 8.2 0 1 1 3.8 13M6.3 3.6v3.8h3.8" />
      <text x="12.4" y="15.6" fill="currentColor" font-size="7.4" font-weight="700" text-anchor="middle" font-family="system-ui, sans-serif">10</text>
    </g>
  ),
  "goforward.10": () => (
    <g>
      <path {...S} d="M17.7 7.2A8.2 8.2 0 1 0 20.2 13M17.7 3.6v3.8h-3.8" />
      <text x="11.6" y="15.6" fill="currentColor" font-size="7.4" font-weight="700" text-anchor="middle" font-family="system-ui, sans-serif">10</text>
    </g>
  ),
  "forward.end.fill": () => (
    <g {...F}>
      <path d="M4 5.3v13.4a.9.9 0 0 0 1.4.7l10-6.7a.9.9 0 0 0 0-1.4l-10-6.7a.9.9 0 0 0-1.4.7z" />
      <rect x="17" y="4.6" width="3" height="14.8" rx="1" />
    </g>
  ),
  "arrow.up.arrow.down": () => <path {...S} d="M7.5 19V5M4 8.5 7.5 5 11 8.5M16.5 5v14M13 15.5l3.5 3.5 3.5-3.5" />,
  checklist: () => <path {...S} d="m3.8 6.3 1.6 1.6 3-3M3.8 12.8l1.6 1.6 3-3M11.5 6.5h8.7M11.5 13h8.7M5 19.5h.1M11.5 19.5h8.7" />,
  film: () => (
    <g {...S}>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8 3.5v17M16 3.5v17M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4" />
    </g>
  ),
  "moon.zzz": () => (
    <g {...S}>
      <path d="M13.6 6.6A7.6 7.6 0 1 0 20 15.4a6.2 6.2 0 0 1-6.4-8.8z" />
      <path d="M15 3.5h3.5L15 7.5h3.5M19.5 8.5h2L19.5 11h2" stroke-width={1.5} />
    </g>
  ),
  "moon.zzz.fill": () => (
    <g>
      <path {...F} d="M13.6 6.6A7.6 7.6 0 1 0 20 15.4a6.2 6.2 0 0 1-6.4-8.8z" />
      <path {...S} d="M15 3.5h3.5L15 7.5h3.5M19.5 8.5h2L19.5 11h2" stroke-width={1.5} />
    </g>
  ),
  "moon.fill": () => <path {...F} d="M12.6 3.2a8.9 8.9 0 1 0 8.2 12.4 7.3 7.3 0 0 1-8.2-12.4z" />,
  "sun.max": () => (
    <g {...S}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
    </g>
  ),
  "doc.on.doc": () => (
    <g {...S}>
      <rect x="8" y="7.5" width="11" height="13" rx="2" />
      <path d="M16 4.5H7a2 2 0 0 0-2 2V16" />
    </g>
  ),
  "crown.fill": () => <path {...F} d="M3.2 7.4 7.6 11l4.4-6.4 4.4 6.4 4.4-3.6-1.6 10.1a1 1 0 0 1-1 .8H5.8a1 1 0 0 1-1-.8z" />,
  "flag.checkered": () => (
    <g>
      <path {...S} d="M5 21V4M5 4.5c4.5-2 8.5 2 14 0v9c-5.5 2-9.5-2-14 0" />
      <path {...F} d="M8.7 3.8v4.1c1.4.2 2.6.7 3.8 1.1V5c-1.2-.5-2.5-1-3.8-1.2zm3.8 5.2v4.2c1.3.5 2.5.9 3.8 1V10c-1.3-.1-2.5-.5-3.8-1zm3.8 1v-4.3c1 0 1.9-.2 2.7-.5v4.3c-.8.3-1.7.5-2.7.5zM5 9v4c1.2-.6 2.4-.9 3.7-.9V8c-1.3 0-2.5.4-3.7 1z" />
    </g>
  ),
  "square.and.arrow.up": () => <path {...S} d="M12 14.5V3.5M8.3 7.2 12 3.5l3.7 3.7M8.5 10H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1.5" />,
  "square.and.arrow.down": () => <path {...S} d="M12 3.5v11M8.3 10.8 12 14.5l3.7-3.7M8.5 7.5H7a2 2 0 0 0-2 2v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-1.5" />,
  "play.rectangle.on.rectangle": () => (
    <g>
      <path {...S} d="M6.5 4.5h12a2 2 0 0 1 2 2v9" />
      <rect {...S} x="3.5" y="7.5" width="14" height="12" rx="2" />
      <path {...F} d="M9 10.8v5.4l4.5-2.7z" />
    </g>
  ),
  "camera.viewfinder": () => (
    <g {...S}>
      <path d="M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16" />
      <rect x="7" y="8.5" width="10" height="7.5" rx="1.5" />
      <circle cx="12" cy="12.3" r="1.9" />
    </g>
  ),
  "shield.lefthalf.filled": () => (
    <g>
      <path {...S} d="M12 3 5 5.8v5.6c0 4.4 2.9 7.8 7 9.6 4.1-1.8 7-5.2 7-9.6V5.8z" />
      <path {...F} d="M12 3 5 5.8v5.6c0 4.4 2.9 7.8 7 9.6z" />
    </g>
  ),
  "shield.slash": () => <path {...S} d="M8 4.4 12 3l7 2.8v5.6c0 1.7-.4 3.2-1.2 4.5M16 19c-1.1.8-2.5 1.5-4 2-4.1-1.8-7-5.2-7-9.6V6.6M3.5 3.5l17 17" />,
  "square.stack": () => (
    <g {...S}>
      <rect x="4" y="8" width="16" height="12.5" rx="2" />
      <path d="M6.5 5.2h11M8.5 2.8h7" />
    </g>
  ),
  "square.stack.3d.up": () => <path {...S} d="m12 3.5 8 4-8 4-8-4zM4 12l8 4 8-4M4 16.3l8 4 8-4" />,
  icloud: () => <path {...S} d="M7 18.5h10.3a4 4 0 0 0 .6-8 5.7 5.7 0 0 0-11-1.4A4.7 4.7 0 0 0 7 18.5z" />,
  "icloud.slash": () => <path {...S} d="M7 18.5h9.5M19.6 16.6a4 4 0 0 0-1.7-6.1 5.7 5.7 0 0 0-8.6-4.3M6.1 9.4A4.7 4.7 0 0 0 7 18.5M3.5 3.5l17 17" />,
  "checkmark.icloud": () => (
    <g {...S}>
      <path d="M7 18.5h10.3a4 4 0 0 0 .6-8 5.7 5.7 0 0 0-11-1.4A4.7 4.7 0 0 0 7 18.5z" />
      <path d="m9.4 13.3 2 2 3.4-3.6" />
    </g>
  ),
  "exclamationmark.icloud": () => (
    <g {...S}>
      <path d="M7 18.5h10.3a4 4 0 0 0 .6-8 5.7 5.7 0 0 0-11-1.4A4.7 4.7 0 0 0 7 18.5z" />
      <path d="M12 10v3.4M12 15.8v.1" />
    </g>
  ),
  "exclamationmark.circle": () => (
    <g {...S}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.5v5.5M12 16.3v.1" />
    </g>
  ),
  "exclamationmark.triangle": () => <path {...S} d="M12 4 2.8 19.5h18.4zM12 10v4.3M12 16.9v.1" />,
  "pause.circle": () => (
    <g {...S}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M10 8.8v6.4M14 8.8v6.4" />
    </g>
  ),
  "arrow.up": () => <path {...S} stroke-width={2.4} d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" />,
  "arrow.up.forward": () => <path {...S} d="M7 17 17 7M8.5 7H17v8.5" />,
  "arrow.up.right.square": () => (
    <g {...S}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M9.5 14.5 15 9M10.5 9H15v4.5" />
    </g>
  ),
  "arrow.triangle.branch": () => <path {...S} d="M6 20V4M6 12c0-2.5 2-4.5 4.5-4.5H18M15 4.5l3 3-3 3M6 14c0 2.5 2 4.5 4.5 4.5H18M15 15.5l3 3-3 3" />,
  "pip.enter": () => (
    <g {...S}>
      <path d="M20.5 11V6.5a2 2 0 0 0-2-2h-13a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2H10" />
      <rect x="13" y="13.5" width="8" height="6" rx="1.2" />
    </g>
  ),
  "rectangle.inset.filled": () => (
    <g>
      <rect {...S} x="3" y="5" width="18" height="14" rx="2.2" />
      <rect {...F} x="6" y="8" width="12" height="8" rx="1" />
    </g>
  ),
  "waveform.and.person.filled": () => (
    <g>
      <circle {...F} cx="8" cy="8" r="3" />
      <path {...F} d="M2.5 19.4c.3-3.3 2.6-5.4 5.5-5.4s5.2 2.1 5.5 5.4a.8.8 0 0 1-.8.9H3.3a.8.8 0 0 1-.8-.9z" />
      <path {...S} d="M16 9v6M19 6.5v11M22 10v4" />
    </g>
  ),
  "captions.bubble": () => (
    <g {...S}>
      <path d="M5.5 4.5h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5h-1a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" />
      <path d="M7.5 9.5h4M13.5 9.5h3M7.5 13h2M11.5 13h5" />
    </g>
  ),
  "gauge.with.dots.needle.50percent": () => (
    <g {...S}>
      <path d="M4.2 17.5a8.6 8.6 0 1 1 15.6 0" />
      <path d="M12 13.5V8" />
      <circle cx="12" cy="14.5" r="1.3" />
    </g>
  ),
  gearshape: () => (
    <g {...S}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
      <circle cx="12" cy="12" r="6.3" />
    </g>
  ),
  macwindow: () => (
    <g {...S}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <path d="M3 8.8h18" />
    </g>
  ),
  "sidebar.right": () => (
    <g {...S}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <path d="M15 4.5v15" />
    </g>
  ),
  "person.crop.circle": () => (
    <g {...S}>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 18.2c1.2-2 3.1-3 5.5-3s4.3 1 5.5 3" />
    </g>
  ),
  "arrow.clockwise": () => <path {...S} d="M19 12a7 7 0 1 1-2.1-5M17.5 3.5v3.8h-3.8" />,
};

export interface IconProps {
  name: string;
  /** Box size in px; the Mac's `.font(.system(size:))` maps to about this. */
  size?: number;
  class?: string;
  label?: string;
  style?: CSSProperties;
}

/** One symbol, in currentColor. Decorative unless given a label. */
export function Icon({ name, size = 16, class: className, label, style }: IconProps) {
  const shape = shapes[name] ?? shapes.film!;
  return (
    <svg
      class={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ flex: "none", display: "block", ...style }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      focusable="false"
    >
      {shape()}
    </svg>
  );
}

export const iconNames = Object.keys(shapes);
