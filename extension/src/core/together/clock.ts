// The clock and timers TogetherModel and CloudLibrary run on (C#'s TimeProvider). Tests pass a manual
// clock; the extension uses the system one.

export interface Clock {
  /** Milliseconds since 1970. */
  now(): number;
  /** Runs `fn` once after `ms`. Returns a function that cancels it. */
  schedule(ms: number, fn: () => void): () => void;
  /** Runs `fn` every `ms`, the first time `ms` from now. Returns a function that stops it. */
  every(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  every(ms, fn) {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
};

/** Waits on a clock (C#'s `Task.Delay(…, TimeProvider)`). */
export function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.schedule(ms, resolve);
  });
}

/** A tiny change emitter: listeners hear the name of what changed. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  /** Adds a listener. Returns a function that removes it. */
  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A listener's failure doesn't stop the others, or the model.
      }
    }
  }
}
