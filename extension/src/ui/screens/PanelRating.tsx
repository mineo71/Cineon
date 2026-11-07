// The side panel's rate mode, one poster at a time (RateModeView.swift's queue and keys), and the
// pieces the panel shares. Kept apart from Panel.tsx so it can be tested without the whole page.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Title } from "../../core/data";
import { HoverButton, OutlineButton } from "../components/controls";
import { PosterImage, StarRatingControl } from "../components/media";
import { useKeys, useModel, useSession } from "../lib/hooks";
import { nudged, rateDetail, rateKey, rateQueue } from "../lib/library";
import { titleHash, waitingText } from "../lib/popup";
import { addStyles } from "../lib/styles";
import css from "./panel.css";

addStyles(css);

/** The Cineon page's address, with a hash such as `#library?title=12`. */
export function appUrl(hash = ""): string {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  const base = runtime?.getURL ? runtime.getURL("app.html") : "app.html";
  return base + hash;
}

export function SectionHead({ name, detail }: { name: string; detail?: string | null }) {
  return (
    <div class="panel-section-head">
      <h2 class="t-title">{name}</h2>
      {detail && <span class="time">{detail}</span>}
    </div>
  );
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  return element.isContentEditable || element.closest("input, textarea, select") != null;
}

/**
 * Rate mode, one poster at a time: unrated watched films, most recent first. 1 to 0 rate and move
 * on after 0.38 s, arrows add or take half a star, Delete clears, Return or Space skips.
 */
export function QuickRating() {
  const model = useModel();
  const session = useSession();
  const library = session.library;
  const [queue, setQueue] = useState<number[]>(() => rateQueue(library.titles.values(), false));
  const [index, setIndex] = useState(0);
  const [rated, setRated] = useState(0);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const id = queue[index];
  const current: Title | null = id != null ? library.titles.get(id) ?? null : null;
  const remaining = Math.max(0, queue.length - index);

  useEffect(() => () => {
    if (advance.current) clearTimeout(advance.current);
  }, []);

  const next = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
    setIndex((i) => i + 1);
  };
  const previous = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
    setIndex((i) => Math.max(0, i - 1));
  };
  const set = (title: Title, halves: number | null, andMove: boolean) => {
    void library.setRating(title.id, halves);
    if (halves != null) setRated((n) => n + 1);
    if (!andMove) return;
    if (advance.current) clearTimeout(advance.current);
    advance.current = setTimeout(next, 380);
  };
  const lookAgain = () => {
    setQueue(rateQueue(library.titles.values(), false));
    setIndex(0);
    setRated(0);
  };

  useKeys((event) => {
    if (!current || isEditable(event.target)) return false;
    const action = rateKey(event);
    if (!action) return false;
    switch (action.kind) {
      case "rate":
        set(current, action.halves, true);
        return true;
      case "nudge":
        void library.setRating(current.id, nudged(current.ratingHalves, action.step));
        return true;
      case "clear":
        set(current, null, false);
        return true;
      case "next": {
        // Return and Space still press a focused button anywhere but the card.
        const target = event.target as Node | null;
        const onCard = target == null || target === document.body || (card.current?.contains(target) ?? false);
        if (!onCard) return false;
        next();
        return true;
      }
      default:
        return false;
    }
  });

  if (!current) {
    if (queue.length === 0 && rated === 0) {
      return (
        <section class="panel-section">
          <SectionHead name="Rate your films" />
          <p class="panel-quiet">
            Everything you've watched has its stars.
            <HoverButton class="panel-link" onClick={lookAgain}>
              Look again
            </HoverButton>
          </p>
        </section>
      );
    }
    return (
      <section class="panel-section">
        <SectionHead name="Rate your films" />
        <p class="panel-quiet">
          {rated > 0 ? `That's all of them. You rated ${rated} ${rated === 1 ? "film" : "films"}.` : "That's all of them."}
          <HoverButton class="panel-link" onClick={lookAgain}>
            Look again
          </HoverButton>
        </p>
      </section>
    );
  }

  return (
    <section class="panel-section">
      <SectionHead name="Rate your films" detail={waitingText(remaining)} />
      <div class="panel-rate" ref={card} tabIndex={-1} key={current.id}>
        <div class="row" style={{ gap: "12px", alignItems: "flex-start" }}>
          <button
            type="button"
            class="panel-rate-poster"
            title={`${current.name}: details`}
            aria-label={`${current.name}: details`}
            onClick={() => void model.openUrl(appUrl(titleHash(current.id)))}
          >
            <PosterImage title={current} width={64} radius={5} keepsColour />
          </button>
          <div class="col" style={{ gap: "4px", minWidth: 0 }}>
            <span class="t-title line2 panel-rate-name">{current.name}</span>
            <span class="panel-rate-detail">{rateDetail(current)}</span>
          </div>
        </div>
        <StarRatingControl
          halves={current.ratingHalves}
          size={17}
          spacing={3}
          label={`Rate ${current.name}`}
          onChange={(value) => set(current, value, value != null)}
        />
        <span class="panel-rate-hint">Press 1 to 0, or click a star. Arrows add or take away half a star.</span>
        <div class="row" style={{ gap: "8px" }}>
          <OutlineButton onClick={next}>Skip</OutlineButton>
          {index > 0 && (
            <HoverButton class="panel-link" onClick={previous}>
              Back
            </HoverButton>
          )}
        </div>
      </div>
    </section>
  );
}
