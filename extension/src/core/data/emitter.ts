/** A tiny change notifier: `on` returns the function that stops listening. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Calls every listener. One that throws is reported and doesn't stop the others. */
  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
