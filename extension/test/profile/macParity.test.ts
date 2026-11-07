// Byte-for-byte agreement with the Mac, ported from windows/Cineon.Core.Tests/Profile/PixelPetMacParityTests.cs
// and ProfileStatsMacParityTests.cs. Each section of macParity/petDump.ts is the same text that
// MacParity/PetDump.swift prints when compiled together with Cineon/Profile/PixelPet.swift; the expected
// FNV-1a hashes are what the Swift program printed (the Windows port asserts the same ones).
//
// To see a difference, set CINEON_PET_DUMP to a folder, run the tests, and diff it against the Swift
// tool's output folder.

import { PixelPet, stableHash } from "../../src/core/profile";
import { fnvPixels, SECTIONS } from "./macParity/petDump";
import { zone } from "./macParity/statsDump";

function hex(text: string): string {
  return stableHash(text).toString(16);
}

/** Writes the section to $CINEON_PET_DUMP when set (Node's modules are untyped here: no @types/node). */
async function keep(name: string, text: string): Promise<void> {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  const dir = env?.CINEON_PET_DUMP;
  if (!dir) return;
  const fs = await import("node:" + "fs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${name}.txt`, text);
}

describe("the pixel pet matches the Mac", () => {
  const expected: [string, string][] = [
    ["renders", "78aea7e4dc9ba324"],
    ["pixels", "f705a07564d61d98"],
    ["frames", "4cd22b86e321acf6"],
    ["traits", "e668683c498dacf1"],
    ["genres", "f9b97fa61879dd82"],
    ["codes", "ff82e116608064b3"],
    ["bounds", "2a3ac7697684bcf2"],
    ["art", "84dd6347313b7969"],
    ["views", "97b863a4d9278767"],
  ];

  test.each(expected)("%s", async (section, hash) => {
    const text = SECTIONS.find((s) => s.name === section)!.make();
    await keep(section, text);
    expect(hex(text)).toBe(hash);
  }, 120_000);

  // Code, then FNV-1a of the 24×24 pixels (each 0xAARRGGBB little-endian) at rest and at 0, 0.25 and
  // 1234.56 s, as the Mac renders them (lines of the Swift tool's renders.txt).
  test.each([
    ["p1-000000100m", "e2d53d061b245046", "833aa8c1085d4580", "c8f95c5529f21680", "24dfd12e6bd08f78"],
    ["p1-02313050z9", "eb5a4f11d7e14e31", "ccb6bbedbc15dce5", "ccb6bbedbc15dce5", "72699ed0c5b476a1"],
    ["p1-822001qz0k", "bfbf5c460888c40", "5f65f0eee4dfdf22", "7394bc7347a383a2", "5f65f0eee4dfdf22"],
    ["p1-e10030zp3k", "fb58c0c5a0d528b7", "255584336a7288a7", "6cc5dbfd94bb90b7", "c748a60a8f0971bc"],
  ])("known code %s renders to the Mac's pixels", (code, resting, at0, at025, at1234) => {
    const pet = PixelPet.fromCode(code);
    expect(pet).not.toBeNull();
    expect(fnvPixels(pet!.bitmap().pixels)).toBe(resting);
    expect(fnvPixels(pet!.bitmap(pet!.frameAt(0)).pixels)).toBe(at0);
    expect(fnvPixels(pet!.bitmap(pet!.frameAt(0.25)).pixels)).toBe(at025);
    expect(fnvPixels(pet!.bitmap(pet!.frameAt(1234.56)).pixels)).toBe(at1234);
  });
});

// 300 generated libraries (titles, sessions, progress) per time zone, every field printed, compared by
// FNV-1a hash with what MacParity/StatsDump.swift printed when compiled with the Mac's Models.swift,
// ProfileStats.swift and PixelPet.swift.
describe("profile stats match the Mac", () => {
  test.each([
    ["UTC", "fb51d6992ef89170"],
    ["Europe/Berlin", "23ff2a41ad5d37e0"],
    ["America/Los_Angeles", "b69424fa84642e0e"],
    ["Asia/Kolkata", "c3e0d3ea213d214f"],
    ["Pacific/Chatham", "58e241675cf684f7"],
  ])("%s", async (zoneId, hash) => {
    const text = zone(zoneId);
    await keep("stats-" + zoneId.replace("/", "-"), text);
    expect(hex(text)).toBe(hash);
  }, 60_000);
});
