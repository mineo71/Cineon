// Port of TogetherIdentity at the bottom of Cineon/Core/TogetherClient.swift (C#: TogetherIdentity.cs).
// The apps keep it in Profiles/<UUID>/together.json; here it's the same JSON text, kept wherever the
// runtime's IdentityStore puts it (chrome.storage.local). It's written the way Swift's JSONEncoder
// writes the struct, with absent optionals left out:
// {"secret":"…","name":"…","personId":"…","openedShares":["K7Q2MX"],"partyCode":"…","pet":"…"}
// so a profile's identity can move between the apps and the extension as that file.

/** Where a profile's identity is kept: the text of together.json. */
export interface IdentityStore {
  /** The stored text, or null when there's none. */
  read(): Promise<string | null> | string | null;
  /** Replaces it. Writes happen in the order they're asked for. */
  write(text: string): Promise<void> | void;
}

/** An IdentityStore in memory, for tests and for profiles that don't keep anything. */
export function memoryIdentityStore(initial: string | null = null): IdentityStore & { text: string | null; writes: number } {
  const store = {
    text: initial,
    writes: 0,
    read: () => store.text,
    write: (text: string) => {
      store.text = text;
      store.writes++;
    },
  };
  return store;
}

/** Who this profile is to the server: a random key and a name. */
export class TogetherIdentity {
  static readonly FILE_NAME = "together.json";

  /** 32 random bytes in standard base64 (44 characters). The server keeps only its SHA-256. */
  secret = "";
  name = "";
  personId: string | null = null;
  /** Codes of friends' lists opened here, newest first, at most 20. */
  openedShares: string[] = [];
  partyCode: string | null = null;
  /** The pixel pet's code as the server last heard it. */
  pet: string | null = null;

  /** The stored identity, or a new one (saved straight away) when there's none or it can't be read. */
  static async load(store: IdentityStore, name: string): Promise<TogetherIdentity> {
    try {
      const text = await store.read();
      const stored = text === null ? null : TogetherIdentity.decode(text);
      if (stored) return stored;
    } catch {
      // Unreadable storage is treated like an unreadable file.
    }
    // Like the Mac, an identity that can't be read is replaced by a new one.
    const identity = new TogetherIdentity();
    identity.secret = TogetherIdentity.newSecret();
    identity.name = name;
    await identity.save(store);
    return identity;
  }

  /** Writes it; a failure is dropped, as the Mac's `try?` does. */
  async save(store: IdentityStore): Promise<void> {
    try {
      await store.write(this.encode());
    } catch {
      // Nothing to do: the next save tries again.
    }
  }

  static newSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  encode(): string {
    const out: Record<string, unknown> = { secret: this.secret, name: this.name };
    if (this.personId !== null) out.personId = this.personId;
    // Always written: the Mac's decoder requires it.
    out.openedShares = [...this.openedShares];
    if (this.partyCode !== null) out.partyCode = this.partyCode;
    if (this.pet !== null) out.pet = this.pet;
    return JSON.stringify(out);
  }

  /** Reads the Mac's file. Null when it isn't one; a missing `openedShares` is forgiven. */
  static decode(text: string): TogetherIdentity | null {
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
    const o = root as Record<string, unknown>;
    const shares: string[] = [];
    if (Array.isArray(o.openedShares)) {
      for (const item of o.openedShares) {
        if (typeof item !== "string") return null;
        shares.push(item);
      }
    }
    if (typeof o.secret !== "string" || typeof o.name !== "string") return null;
    const optional = (key: string): string | null | undefined => {
      const value = o[key];
      if (value === undefined || value === null) return null;
      return typeof value === "string" ? value : undefined;
    };
    const personId = optional("personId");
    const partyCode = optional("partyCode");
    const pet = optional("pet");
    if (personId === undefined || partyCode === undefined || pet === undefined) return null;
    const identity = new TogetherIdentity();
    identity.secret = o.secret;
    identity.name = o.name;
    identity.personId = personId;
    identity.openedShares = shares;
    identity.partyCode = partyCode;
    identity.pet = pet;
    return identity;
  }

  /**
   * Foundation's `Data(base64Encoded:)` with no options: the standard alphabet, padded to a multiple
   * of four, no whitespace.
   */
  static isStrictBase64(text: string): boolean {
    if (text.length % 4 !== 0) return false;
    const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
    return /^[A-Za-z0-9+/]*$/.test(text.slice(0, text.length - padding));
  }
}
