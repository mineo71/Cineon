// RateModeView.swift: rates everything you've watched, one poster at a time, as fast as you can
// press keys. Unrated films come first, most recently watched first. Every rating saves as it's given.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Title } from "../../core/data";
import { HoverButton, OutlineButton, SilverButton, Switch } from "../components/controls";
import { PetView, PosterImage, RemoteImage, StarRatingControl } from "../components/media";
import { useModel, useSession } from "../lib/hooks";
import { nudged, rateDetail, rateFinishedText, rateKey, rateQueue } from "../lib/library";
import { addStyles } from "../lib/styles";
import css from "./rate.css";

addStyles(css);

/** Text fields and the like keep their keys; everything else on the page rates. */
function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  return element.isContentEditable || element.closest("input, textarea, select") != null;
}

export function RateModeView() {
  const model = useModel();
  const session = useSession();
  const library = session.library;
  const [includeRated, setIncludeRated] = useState(false);
  const [queue, setQueue] = useState<number[]>(() => rateQueue(library.titles.values(), false));
  const [index, setIndex] = useState(0);
  const [rated, setRated] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);

  const id = queue[index];
  const current: Title | null = id != null ? library.titles.get(id) ?? null : null;

  const cancelAdvance = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
  };

  const buildQueue = (include: boolean) => {
    cancelAdvance();
    setQueue(rateQueue(library.titles.values(), include));
    setIndex(0);
    setRated(0);
    setDirection("forward");
  };

  const next = () => {
    cancelAdvance();
    setDirection("forward");
    setIndex((i) => i + 1);
  };

  const previous = () => {
    cancelAdvance();
    if (index === 0) return;
    setDirection("back");
    setIndex((i) => Math.max(0, i - 1));
  };

  const set = (halves: number | null, andMove: boolean) => {
    if (!current) return;
    void library.setRating(current.id, halves);
    if (halves != null) setRated((n) => n + 1);
    if (!andMove) return;
    cancelAdvance();
    advance.current = setTimeout(next, 380);
  };

  // The latest closures for the key listener.
  const latest = useRef({ current, set, next, model });
  latest.current = { current, set, next, model };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      const action = rateKey(event);
      if (!action) return;
      const target = event.target as HTMLElement | null;
      // A focused button or switch handles Return and Space itself.
      if ((event.key === "Enter" || event.key === " ") && target?.closest?.("button, [role=switch]")) return;
      const { current: title, set: rate, next: skip, model: app } = latest.current;
      switch (action.kind) {
        case "exit":
          app.go("library");
          break;
        case "next":
          skip();
          break;
        case "rate":
          rate(action.halves, true);
          break;
        case "clear":
          rate(null, false);
          break;
        case "nudge":
          if (title) void app.library.setRating(title.id, nudged(title.ratingHalves, action.step));
          break;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAdvance();
    };
  }, []);

  return (
    <div class="rate-mode">
      {/* Behind, not beside: a poster filling the page mustn't push the card around. */}
      {current && <Backdrop title={current} />}
      {current ? (
        <div class={`rate-card ${direction}`} key={current.id}>
          <div class="rate-header">
            <span class="t-title" style={{ fontSize: "22px", color: "var(--ink)" }}>
              Rate your films
            </span>
            <span class="time rate-count">{`${Math.min(index + 1, queue.length)} of ${queue.length}`}</span>
            <span class="spacer" />
            <label class="row rate-include">
              <span>Include rated ones</span>
              <Switch
                mini
                on={includeRated}
                label="Include rated ones"
                onChange={(value) => {
                  setIncludeRated(value);
                  buildQueue(value);
                }}
              />
            </label>
            <OutlineButton style={{ marginLeft: "12px" }} onClick={() => model.go("library")}>
              Done
            </OutlineButton>
            <div class="rate-progress" aria-hidden="true">
              <i style={{ width: `${queue.length === 0 ? 0 : (index / queue.length) * 100}%` }} />
            </div>
          </div>
          <span class="spacer-v" />
          <div class="row rate-body">
            <div class="rate-poster">
              <PosterImage title={current} width={230} radius={10} keepsColour />
            </div>
            <div class="col rate-text">
              <span class="t-title rate-name">{current.name}</span>
              <span class="rate-detail">{rateDetail(current)}</span>
              <div style={{ paddingTop: "18px" }}>
                <StarRatingControl
                  halves={current.ratingHalves}
                  size={30}
                  spacing={5}
                  label={`Rate ${current.name}`}
                  onChange={(value) => set(value, value != null)}
                />
              </div>
              <span class="rate-hint">Click a star, or press 1 to 0. Arrows add or take away half a star.</span>
              <div class="row" style={{ gap: "10px", paddingTop: "8px" }}>
                <OutlineButton onClick={next}>Skip</OutlineButton>
                {index > 0 && (
                  <HoverButton style={{ color: "var(--ink2)" }} onClick={previous}>
                    Back
                  </HoverButton>
                )}
                {current.ratingHalves != null && <SilverButton onClick={next}>Next</SilverButton>}
              </div>
            </div>
          </div>
          <span class="spacer-v" />
          {/* The next few posters, so the end is always in sight. */}
          <div class="row rate-upcoming">
            {queue.slice(index + 1, index + 9).map((upcoming) => {
              const title = library.titles.get(upcoming);
              return title ? (
                <div key={upcoming} style={{ opacity: 0.55 }}>
                  <PosterImage title={title} width={46} radius={4} />
                </div>
              ) : null;
            })}
          </div>
        </div>
      ) : (
        <Finished
          empty={queue.length === 0}
          rated={rated}
          again={() => {
            setIncludeRated(true);
            buildQueue(true);
          }}
        />
      )}
    </div>
  );
}

function Backdrop({ title }: { title: Title }) {
  return (
    <div class="rate-backdrop" aria-hidden="true">
      <RemoteImage url={title.backdropUrl ?? title.posterUrl} class="rate-backdrop-image" />
      <div class="rate-backdrop-shade" />
    </div>
  );
}

function Finished({ empty, rated, again }: { empty: boolean; rated: number; again: () => void }) {
  const model = useModel();
  const session = useSession();
  const { pet } = session.statsAndPet();
  return (
    <div class="col rate-finished">
      <PetView pet={pet} size={120} />
      <span class="t-title" style={{ fontSize: "30px", color: "var(--ink)" }}>
        {empty ? "Nothing left to rate" : "That's all of them"}
      </span>
      <span style={{ fontSize: "14px", color: "var(--ink2)" }}>{rateFinishedText(rated)}</span>
      <div class="row" style={{ gap: "10px", paddingTop: "6px" }}>
        <OutlineButton onClick={again}>Go over rated ones</OutlineButton>
        <SilverButton onClick={() => model.go("library")}>See your library</SilverButton>
      </div>
    </div>
  );
}
