// Preact hooks over the page model. Views read the model synchronously and re-render when it
// says something changed; collections are replaced, never mutated, so `useMemo` on them is safe.

import { type RefObject, createContext } from "preact";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AppModel, UiState } from "./app";
import type { Live, LiveSet } from "./live";
import type { Session } from "./session";

export interface PageContext {
  model: AppModel;
  live: LiveSet;
}

export const Page = createContext<PageContext | null>(null);

export function usePage(): PageContext {
  const page = useContext(Page);
  if (!page) throw new Error("No Cineon page context");
  return page;
}

export function useModel(): AppModel {
  return usePage().model;
}

/** Re-renders when `subscribe` says so. */
export function useSubscription(subscribe: (listener: () => void) => () => void): void {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((n) => n + 1)), [subscribe]);
}

/** The page's UI state (route, overlays, toast). */
export function useUi(): UiState {
  const model = useModel();
  useSubscription(useCallback((l: () => void) => model.subscribe(l), [model]));
  return model.state;
}

/** The open profile; re-renders on any library, settings or profile change. */
export function useSession(): Session {
  const model = useModel();
  useSubscription(useCallback((l: () => void) => model.subscribe(l), [model]));
  const session = model.session;
  useSubscription(useCallback((l: () => void) => session.subscribe(l), [session]));
  return session;
}

/** A background value; null until it answers (or when it doesn't). */
export function useLive<T>(pick: (live: LiveSet) => Live<T>): { value: T | null; answered: boolean; settled: boolean; live: Live<T> } {
  const live = pick(usePage().live);
  useSubscription(useCallback((l: () => void) => live.subscribe(l), [live]));
  return { value: live.value, answered: live.answered, settled: live.settled, live };
}

/** `.onHover`. */
export function useHover(): [boolean, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [hovered, setHovered] = useState(false);
  const handlers = useMemo(() => ({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }), []);
  return [hovered, handlers];
}

/** An element's width, following resizes (onGeometryChange). */
export function useWidth<T extends HTMLElement>(fallback = 1400): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth || fallback);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

/** prefers-reduced-motion. */
export function useReducedMotion(): boolean {
  const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduce, setReduce] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const listener = () => setReduce(query.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  return reduce;
}

/** Keys at the window level (KeyMonitor). Return true when handled. */
export function useKeys(handler: (event: KeyboardEvent) => boolean | void, active = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => {
      if (latest.current(event) === true) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [active]);
}

/** A value that settles `ms` after it stops changing (the Mac's 220 ms typing pause). */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** `.task(id:)`: runs `load` when `deps` change; drops answers to stale runs. */
export function useTask<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], initial: T): [T, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    load(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setValue(result);
        setBusy(false);
      },
      () => {
        if (!controller.signal.aborted) setBusy(false);
      },
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [value, busy];
}

/** Ticks every `ms` while mounted (TimelineView(.periodic)). */
export function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, active]);
  return now;
}
