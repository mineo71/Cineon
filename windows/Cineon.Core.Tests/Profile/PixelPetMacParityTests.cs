using Cineon.Core.Profile;
using Cineon.Core.Tests.Profile.MacParity;

namespace Cineon.Core.Tests.Profile;

/// <summary>
/// Byte-for-byte agreement with the Mac. Each section of <see cref="PetDump"/> is the same text that
/// MacParity/PetDump.swift prints when compiled together with Cineon/Profile/PixelPet.swift; the expected
/// FNV-1a hashes below are what the Swift program printed. Covered: every species × stage × accessory × tone
/// × mood rendered at rest and at nine times (all 24×24 pixels), animation frames over thousands of instants,
/// 3000 generated pets (code, name, blurb, growth, genre ranking), genre aliases, code decoding (valid,
/// mutated and garbage), content bounds and tight crops, the sprite and palette tables, and the SwiftUI view
/// itself rendered offscreen at avatar to hero sizes at 1× and 2× (premultiplied BGRA).
///
/// To see a difference, set CINEON_PET_DUMP to a folder, run the tests, and diff it against the Swift
/// tool's output folder.
/// </summary>
public class PixelPetMacParityTests
{
    public static TheoryData<string, string> Expected => new()
    {
        { "renders", "78aea7e4dc9ba324" },
        { "pixels", "f705a07564d61d98" },
        { "frames", "4cd22b86e321acf6" },
        { "traits", "e668683c498dacf1" },
        { "genres", "f9b97fa61879dd82" },
        { "codes", "ff82e116608064b3" },
        { "bounds", "2a3ac7697684bcf2" },
        { "art", "84dd6347313b7969" },
        { "views", "97b863a4d9278767" },
    };

    [Theory]
    [MemberData(nameof(Expected))]
    public void MatchesTheMac(string section, string expected)
    {
        var text = PetDump.Sections.Single(s => s.Name == section).Make();
        if (Environment.GetEnvironmentVariable("CINEON_PET_DUMP") is { Length: > 0 } dir)
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, section + ".txt"), text);
        }
        Assert.Equal(expected, PixelPet.StableHash(text).ToString("x"));
    }

    [Theory]
    // Code, then FNV-1a of the 24×24 pixels (each 0xAARRGGBB little-endian) at rest and at 0, 0.25 and
    // 1234.56 s, as the Mac renders them (lines of the Swift tool's renders.txt).
    [InlineData("p1-000000100m", "e2d53d061b245046", "833aa8c1085d4580", "c8f95c5529f21680", "24dfd12e6bd08f78")]
    [InlineData("p1-02313050z9", "eb5a4f11d7e14e31", "ccb6bbedbc15dce5", "ccb6bbedbc15dce5", "72699ed0c5b476a1")]
    [InlineData("p1-822001qz0k", "bfbf5c460888c40", "5f65f0eee4dfdf22", "7394bc7347a383a2", "5f65f0eee4dfdf22")]
    [InlineData("p1-e10030zp3k", "fb58c0c5a0d528b7", "255584336a7288a7", "6cc5dbfd94bb90b7", "c748a60a8f0971bc")]
    public void KnownCodesRenderToTheMacsPixels(string code, string resting, string at0, string at025, string at1234)
    {
        var pet = PixelPet.FromCode(code);
        Assert.NotNull(pet);
        string Hash(PetBitmap bitmap) => PetDump.Fnv(bitmap.Pixels).ToString("x");
        Assert.Equal(resting, Hash(pet.Value.Bitmap()));
        Assert.Equal(at0, Hash(pet.Value.Bitmap(pet.Value.FrameAt(0))));
        Assert.Equal(at025, Hash(pet.Value.Bitmap(pet.Value.FrameAt(0.25))));
        Assert.Equal(at1234, Hash(pet.Value.Bitmap(pet.Value.FrameAt(1234.56))));
    }
}
