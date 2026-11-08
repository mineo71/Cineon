// Where unfinished streams wait: the origin private file system (OPFS), the extension's own
// folder that the browser keeps across restarts. Windows keeps them in `.cineon-partial\` beside
// the films; here they live in OPFS `cineon-partial/<key>.hls/` until the film is in Downloads.
//
// OPFS writes are atomic: a writable stream works on a copy and only replaces the file on close().
// But getFileHandle({create: true}) makes an empty file straight away, so an empty file counts as
// missing (a real segment is never empty).

/** The part of an OPFS directory handle (`FileSystemDirectoryHandle`) used here. */
export interface OpfsDirectory {
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

/** The part of `FileSystemFileHandle` used here. */
export interface OpfsFile {
  getFile(): Promise<Blob>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
}

/** The part of `FileSystemWritableFileStream` used here. */
export interface OpfsWritable {
  write(data: Uint8Array | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** The folder of partial streams. */
export class PartStore {
  static readonly folderName = "cineon-partial";

  constructor(private readonly root: OpfsDirectory) {}

  /** The browser's OPFS (`navigator.storage.getDirectory()`), folder `cineon-partial`. */
  static async open(storage: StorageManager = navigator.storage): Promise<PartStore> {
    const opfs = (await storage.getDirectory()) as unknown as OpfsDirectory;
    return new PartStore(await opfs.getDirectoryHandle(PartStore.folderName, { create: true }));
  }

  /** A folder of parts, made when `create`; null when it isn't there. */
  async folder(name: string, create = true): Promise<PartFolder | null> {
    try {
      return new PartFolder(name, await this.root.getDirectoryHandle(name, { create }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.root.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async names(): Promise<string[]> {
    const names: string[] = [];
    for await (const name of this.root.keys()) names.push(name);
    return names.sort();
  }
}

/** One stream's parts. */
export class PartFolder {
  constructor(
    readonly name: string,
    private readonly dir: OpfsDirectory,
  ) {}

  async names(): Promise<string[]> {
    const names: string[] = [];
    for await (const name of this.dir.keys()) names.push(name);
    return names.sort();
  }

  /** The file, or null when it's missing or empty. */
  async file(name: string): Promise<Blob | null> {
    try {
      const file = await (await this.dir.getFileHandle(name)).getFile();
      return file.size > 0 ? file : null;
    } catch (error) {
      if (isNotFound(error) || isTypeMismatch(error)) return null;
      throw error;
    }
  }

  async has(name: string): Promise<boolean> {
    return (await this.file(name)) != null;
  }

  async size(name: string): Promise<number> {
    return (await this.file(name))?.size ?? 0;
  }

  async readText(name: string): Promise<string | null> {
    const file = await this.file(name);
    return file == null ? null : file.text();
  }

  /** Replaces the file in one step. */
  async write(name: string, data: Uint8Array | string | Blob): Promise<void> {
    const writable = await (await this.dir.getFileHandle(name, { create: true })).createWritable({
      keepExistingData: false,
    });
    try {
      await writable.write(data);
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    await writable.close();
  }

  /** Replaces the file with what `fill` writes, piece by piece. Returns its size. */
  async fill(name: string, fill: (write: (chunk: Uint8Array) => Promise<void>) => Promise<unknown>): Promise<number> {
    const writable = await (await this.dir.getFileHandle(name, { create: true })).createWritable({
      keepExistingData: false,
    });
    let size = 0;
    try {
      await fill(async (chunk) => {
        await writable.write(chunk);
        size += chunk.length;
      });
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    await writable.close();
    return size;
  }

  async remove(name: string): Promise<void> {
    try {
      await this.dir.removeEntry(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /** Writes the named files, in order, into `target`. Returns its size. */
  async join(target: string, names: readonly string[], signal?: AbortSignal): Promise<number> {
    const writable = await (await this.dir.getFileHandle(target, { create: true })).createWritable({
      keepExistingData: false,
    });
    let size = 0;
    try {
      for (const name of names) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Stopped", "AbortError");
        const file = await (await this.dir.getFileHandle(name)).getFile();
        await writable.write(file);
        size += file.size;
      }
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    await writable.close();
    return size;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error != null && (error as { name?: unknown }).name === "NotFoundError";
}

function isTypeMismatch(error: unknown): boolean {
  return typeof error === "object" && error != null && (error as { name?: unknown }).name === "TypeMismatchError";
}
