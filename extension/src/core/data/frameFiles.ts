// The apps keep frame images in a Frames folder next to the profile database, named
// `<titleId>/<name>.jpg`. Here they're records in the profile database's `frame_files` store by
// default, behind an interface so another home (OPFS) can be swapped in.

import { type Database, type FrameData, frameDataSize } from "./database";

export type { FrameData };

export interface FrameFiles {
  read(file: string): Promise<FrameData | null>;
  write(file: string, data: FrameData): Promise<void>;
  remove(file: string): Promise<void>;
  /** Everything under `<titleId>/`, the title's folder. */
  removeTitle(titleId: number): Promise<void>;
  /** The whole Frames folder. */
  removeAll(): Promise<void>;
  /** Bytes per file. */
  sizes(): Promise<Map<string, number>>;
}

/** Frame images in the profile's own database. */
export class IdbFrameFiles implements FrameFiles {
  constructor(private readonly db: Database) {}

  read(file: string): Promise<FrameData | null> {
    return this.db.readFrameFile(file);
  }

  write(file: string, data: FrameData): Promise<void> {
    return this.db.writeFrameFile(file, data);
  }

  remove(file: string): Promise<void> {
    return this.db.deleteFrameFiles(file, true);
  }

  removeTitle(titleId: number): Promise<void> {
    return this.db.deleteFrameFiles(`${titleId}/`);
  }

  removeAll(): Promise<void> {
    return this.db.deleteFrameFiles("");
  }

  sizes(): Promise<Map<string, number>> {
    return this.db.frameFileSizes();
  }
}

/** Frame images in memory, for tests and previews. */
export class MemoryFrameFiles implements FrameFiles {
  readonly files = new Map<string, FrameData>();

  async read(file: string): Promise<FrameData | null> {
    return this.files.get(file) ?? null;
  }

  async write(file: string, data: FrameData): Promise<void> {
    this.files.set(file, data);
  }

  async remove(file: string): Promise<void> {
    this.files.delete(file);
  }

  async removeTitle(titleId: number): Promise<void> {
    for (const file of [...this.files.keys()]) if (file.startsWith(`${titleId}/`)) this.files.delete(file);
  }

  async removeAll(): Promise<void> {
    this.files.clear();
  }

  async sizes(): Promise<Map<string, number>> {
    return new Map([...this.files].map(([file, data]) => [file, frameDataSize(data)]));
  }
}
