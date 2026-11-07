// FNV-1a, 64-bit, the hash the pet uses for names, tones and code checksums (PixelPet.stableHash on the
// Mac and Windows). Kept as two unsigned 32-bit halves so hashing stays fast without BigInt.

const OFFSET_HI = 0xcbf29ce4;
const OFFSET_LO = 0x84222325;
const TWO_32 = 4294967296;

/** A running FNV-1a 64-bit hash. */
export class Fnv64 {
  hi = OFFSET_HI;
  lo = OFFSET_LO;

  /** Mixes in one byte (0...255). */
  byte(b: number): this {
    const lo = (this.lo ^ b) >>> 0;
    // (hi·2³² + lo) × (2⁴⁰ + 0x1b3) mod 2⁶⁴.
    const product = lo * 0x1b3;
    this.lo = product >>> 0;
    this.hi = (Math.imul(this.hi, 0x1b3) + Math.floor(product / TWO_32) + (lo << 8)) >>> 0;
    return this;
  }

  bytes(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.byte(bytes[i]!);
    return this;
  }

  /** Each value's four bytes, little-endian (how the parity dumps hash 0xAARRGGBB pixels). */
  uint32s(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      this.byte(v & 0xff).byte((v >>> 8) & 0xff).byte((v >>> 16) & 0xff).byte(v >>> 24);
    }
    return this;
  }

  /** The UTF-8 bytes of `text`. */
  text(text: string): this {
    return this.bytes(new TextEncoder().encode(text));
  }

  /** `value mod n` for small n (the 64-bit value is hi·2³² + lo). */
  mod(n: number): number {
    return ((this.hi % n) * (TWO_32 % n) + (this.lo % n)) % n;
  }

  bigint(): bigint {
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }

  /** Lower-case hex without leading zeros, like C#'s `ToString("x")` and Swift's `String(_, radix: 16)`. */
  hex(): string {
    return this.hi === 0 ? this.lo.toString(16) : this.hi.toString(16) + this.lo.toString(16).padStart(8, "0");
  }
}

/** FNV-1a, 64-bit, over the UTF-8 bytes of `text`. Stable across launches and platforms. */
export function stableHash(text: string): bigint {
  return new Fnv64().text(text).bigint();
}
