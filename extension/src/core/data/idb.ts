// Small promise helpers over raw IndexedDB. Requests are awaited inside a transaction, which stays
// active across those awaits (microtasks run before it can commit); never await anything else
// inside `transact`, or the transaction commits early.

export function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Runs `body` in one transaction and resolves with its result once the transaction has committed.
 * Anything thrown, or any failed request, aborts the whole transaction, like a SQLite transaction
 * rolling back.
 */
export async function transact<T>(
  db: IDBDatabase,
  stores: string | readonly string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const tx = db.transaction(stores as string | string[], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException("The transaction was aborted.", "AbortError"));
  });
  // Handled here so a failure noticed before we wait on it isn't reported as unhandled.
  done.catch(() => {});
  let result: T;
  try {
    result = await body(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already finished or aborting.
    }
    await done.catch(() => {});
    throw error;
  }
  await done;
  return result;
}

export function getAll<T>(
  source: IDBObjectStore | IDBIndex,
  query?: IDBValidKey | IDBKeyRange | null,
  count?: number,
): Promise<T[]> {
  return request(source.getAll(query ?? null, count) as IDBRequest<T[]>);
}

export function get<T>(source: IDBObjectStore | IDBIndex, key: IDBValidKey | IDBKeyRange): Promise<T | undefined> {
  return request(source.get(key) as IDBRequest<T | undefined>);
}

/**
 * Walks a cursor, calling `visit` for each record until it returns false. `visit` may update or
 * delete through the cursor.
 */
export function iterate(
  source: IDBObjectStore | IDBIndex,
  query: IDBValidKey | IDBKeyRange | null,
  direction: IDBCursorDirection,
  visit: (cursor: IDBCursorWithValue) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = source.openCursor(query, direction);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const cursor = r.result;
      if (!cursor) return resolve();
      let go: boolean | void;
      try {
        go = visit(cursor);
      } catch (error) {
        reject(error);
        return;
      }
      if (go === false) resolve();
      else cursor.continue();
    };
  });
}

/** Walks an index's keys and primary keys without loading the records. */
export function iterateKeys(index: IDBIndex, visit: (key: IDBValidKey, primaryKey: IDBValidKey) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = index.openKeyCursor();
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const cursor = r.result;
      if (!cursor) return resolve();
      visit(cursor.key, cursor.primaryKey);
      cursor.continue();
    };
  });
}

/** The first `limit` values in index order, or reversed. */
export async function take<T>(
  source: IDBObjectStore | IDBIndex,
  query: IDBValidKey | IDBKeyRange | null,
  direction: IDBCursorDirection,
  limit: number,
): Promise<T[]> {
  const out: T[] = [];
  if (limit <= 0) return out;
  await iterate(source, query, direction, (cursor) => {
    out.push(cursor.value as T);
    return out.length < limit;
  });
  return out;
}

/** Every key whose first part is `first`, for compound indexes such as `[title_id, started_at]`. */
export function prefixRange(first: IDBValidKey): IDBKeyRange {
  return IDBKeyRange.bound([first], [first, []]);
}

/** Error names IndexedDB rejects with: the ones LibraryStore swallows, as Swift's `try?` swallows SQLite's. */
const DATABASE_ERRORS = new Set([
  "AbortError",
  "ConstraintError",
  "DataCloneError",
  "DataError",
  "InvalidAccessError",
  "InvalidStateError",
  "NotFoundError",
  "QuotaExceededError",
  "ReadOnlyError",
  "TimeoutError",
  "TransactionInactiveError",
  "UnknownError",
  "VersionError",
]);

export function isDatabaseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { name: unknown }).name === "string" &&
    DATABASE_ERRORS.has((error as { name: string }).name)
  );
}
