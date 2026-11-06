using System.Globalization;
using System.Text;
using Cineon.Core.Profile;

namespace Cineon.Core.Tests.Profile.MacParity;

/// <summary>
/// The C# twin of PetDump.swift: the same inputs, the same text, line for line. Any change here must be
/// made there too (and the expected hashes in PixelPetMacParityTests regenerated on a Mac).
/// </summary>
internal static class PetDump
{
    private struct SplitMix(ulong state)
    {
        private ulong state = state;

        public ulong Next()
        {
            unchecked
            {
                state += 0x9E37_79B9_7F4A_7C15;
                var z = state;
                z = (z ^ (z >> 30)) * 0xBF58_476D_1CE4_E5B9;
                z = (z ^ (z >> 27)) * 0x94D0_49BB_1331_11EB;
                return z ^ (z >> 31);
            }
        }

        public int Below(int n) => (int)(Next() % (ulong)n);
    }

    public static ulong Fnv(uint[] pixels)
    {
        var hash = 0xcbf2_9ce4_8422_2325UL;
        foreach (var p in pixels)
        {
            for (var shift = 0; shift < 32; shift += 8)
            {
                hash ^= (p >> shift) & 0xFF;
                hash = unchecked(hash * 0x0000_0100_0000_01b3UL);
            }
        }
        return hash;
    }

    public static ulong FnvBytes(byte[] bytes)
    {
        var hash = 0xcbf2_9ce4_8422_2325UL;
        foreach (var b in bytes)
        {
            hash ^= b;
            hash = unchecked(hash * 0x0000_0100_0000_01b3UL);
        }
        return hash;
    }

    private static string Hex(ulong v) => v.ToString("x", CultureInfo.InvariantCulture);

    private static string I(int v) => v.ToString(CultureInfo.InvariantCulture);

    /// <summary>Swift's description of a Double/CGFloat: "24.0", "20.64".</summary>
    private static string SwiftDouble(double v) =>
        v == Math.Floor(v) && Math.Abs(v) < 1e15
            ? v.ToString("0.0", CultureInfo.InvariantCulture)
            : v.ToString("R", CultureInfo.InvariantCulture);

    public static string FrameText(PetFrame f) =>
        $"{I(f.Lift)},{I((int)f.Eyes)},{I((int)f.Mouth)},{I((int)f.Effect)},{I(f.EffectStep)},{I(f.Sparkle ?? -1)}";

    public static readonly string[] GenreNames =
    [
        "Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi", "Mystery",
        "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History", "Family", "Short",
        "Western", "Music", "Documentary", "Musical", "Reality-TV", "Talk-Show", "Game-Show", "News",
        "Film-Noir", "Science Fiction", "Bollywood", "", "Action & Adventure", "Sci-Fi & Fantasy", "War & Politics",
        "Crime/Drama", "Kids, Family", "a+b", ",,,", "&", "  thriller ", "HORROR", "sci fi", "sci\u2011fi",
        "\u212Aids", "\u0130history", "H\u0130STORY", "\uFF28\uFF4F\uFF52\uFF52\uFF4F\uFF52",
        "\u041C\u0443\u0437\u0438\u043A\u0430", "Docu-Series", "Rom-Com", "Stand-Up", "TV Movie", "neo-noir",
        "Children's", "Martial Arts", "Super-hero", "Sci-Fi&Fantasy", "Action/Adventure/Comedy", "action+drama",
        "A\u00E7\u00E3o", "Com\u00E9die", "Ani\u0301me", "\uFF21nime", "anime\0", "\uFEFFDrama", "Dra\u200Bma",
        "Drama\U0001F3AC", "\u0661\u0662drama", "\u216B", "sf", "SF", "Scfi", "realitytv", "realityTV", "filmNoir",
        "talkShow", "gameShow", "sciFi", "Sci-Fi & Fantasy & Horror", "Western/", "/Western",
    ];

    private static PetTraits RandomTraits(ref SplitMix rng)
    {
        var count = rng.Below(7);
        var genres = new List<GenreWeight>();
        for (var i = 0; i < count; i++)
        {
            var name = GenreNames[rng.Below(GenreNames.Length)];
            var kind = rng.Below(25);
            double weight = kind switch
            {
                0 => double.NaN,
                1 => double.PositiveInfinity,
                2 => double.NegativeInfinity,
                3 => rng.Below(5000) / 100.0,
                _ => rng.Below(53) - 2.0,
            };
            genres.Add(new GenreWeight(name, weight));
        }
        var hoursKind = rng.Below(10);
        double hours = hoursKind switch
        {
            0 => 0,
            1 => double.NaN,
            2 => rng.Below(100_000_000) / 7.0,
            _ => rng.Below(3_000_000) / 1000.0,
        };
        var titles = rng.Below(2001);
        var negative = rng.Below(20) == 0;
        var daysKind = rng.Below(3);
        int? days = daysKind == 0 ? null : rng.Below(404) - 3;
        var seedKind = rng.Below(4);
        string seed = seedKind switch
        {
            0 => "seed-" + rng.Next().ToString(CultureInfo.InvariantCulture),
            1 => rng.Next().ToString("X", CultureInfo.InvariantCulture),
            2 => "\u00DCn\u00EFc\u00F8d\u00E9-" + I(rng.Below(1000)),
            _ => "",
        };
        return new PetTraits
        {
            Genres = genres, HoursWatched = hours, TitlesFinished = negative ? titles - 2500 : titles,
            DaysSinceLastWatch = days, Seed = seed,
        };
    }

    private static List<PixelPet> TraitPets()
    {
        var rng = new SplitMix(42);
        var pets = new List<PixelPet>();
        for (var i = 0; i < 3000; i++) pets.Add(PixelPet.Make(RandomTraits(ref rng)));
        return pets;
    }

    // MARK: Sections

    public static readonly IReadOnlyList<(string Name, Func<string> Make)> Sections =
    [
        ("renders", Renders), ("pixels", Pixels), ("frames", Frames), ("traits", Traits), ("genres", Genres),
        ("codes", Codes), ("bounds", Bounds), ("art", Art), ("views", Views),
    ];

    public static string Renders()
    {
        double[] times = [0, 0.25, 0.9, 1.7, 3.1, 4.4, -7.3, 1234.56, 7.77e8];
        var out_ = new StringBuilder();
        var index = 0;
        foreach (var s in Enum.GetValues<PetSpecies>())
        foreach (var st in Enum.GetValues<PetStage>())
        foreach (var a in Enum.GetValues<PetAccessory>())
        foreach (var tn in Enum.GetValues<PetTone>())
        foreach (var m in Enum.GetValues<PetMood>())
        {
            var pet = new PixelPet(s, st, a, tn, m, level: 1 + index % 99, nameIndex: index * 37 % 1024);
            index += 1;
            out_.Append(pet.Code).Append(' ').Append(Hex(Fnv(pet.Bitmap().Pixels)));
            foreach (var t in times) out_.Append(' ').Append(Hex(Fnv(pet.Bitmap(pet.FrameAt(t)).Pixels)));
            out_.Append('\n');
        }
        return out_.ToString();
    }

    public static readonly PixelPet[] SamplePets =
    [
        new(PetSpecies.Fox, PetStage.Legend, PetAccessory.Scarf, PetTone.Sunny, PetMood.Happy, level: 19, nameIndex: 7),
        new(PetSpecies.Ghost, PetStage.Teen, PetAccessory.Horns, PetTone.Dusk, PetMood.Sleepy, level: 5, nameIndex: 300),
        new(PetSpecies.Robot, PetStage.Adult, PetAccessory.Glasses3D, PetTone.Classic, PetMood.Bored, level: 9, nameIndex: 1023),
        new(PetSpecies.Owl, PetStage.Baby, PetAccessory.Headphones, PetTone.Classic, PetMood.Content, level: 1, nameIndex: 0),
    ];

    public static string Pixels()
    {
        var out_ = new StringBuilder();
        foreach (var pet in SamplePets)
        {
            foreach (var frame in new[] { pet.RestingFrame, pet.FrameAt(0.35), pet.FrameAt(2.2) })
            {
                out_.Append(pet.Code).Append(' ').Append(FrameText(frame)).Append('\n');
                var bitmap = pet.Bitmap(frame);
                for (var y = 0; y < PetBitmap.Size; y++)
                {
                    var cells = Enumerable.Range(0, PetBitmap.Size).Select(x =>
                    {
                        var p = bitmap[x, y];
                        return p == 0 ? "......" : (p & 0xFF_FFFF).ToString("x6", CultureInfo.InvariantCulture);
                    });
                    out_.Append(string.Join(' ', cells)).Append('\n');
                }
            }
        }
        return out_.ToString();
    }

    public static string Frames()
    {
        var out_ = new StringBuilder();
        for (var nameIndex = 0; nameIndex < 1024; nameIndex += 37)
        {
            foreach (var mood in Enum.GetValues<PetMood>())
            {
                foreach (var stage in new[] { PetStage.Adult, PetStage.Legend })
                {
                    var pet = new PixelPet(PetSpecies.Cat, stage, mood: mood, nameIndex: nameIndex);
                    out_.Append(pet.Code).Append(" r:").Append(FrameText(pet.RestingFrame));
                    for (var i = 0; i <= 1080; i++) out_.Append(' ').Append(FrameText(pet.FrameAt(i * 0.037 - 20.0)));
                    for (var i = 0; i < 600; i++) out_.Append(' ').Append(FrameText(pet.FrameAt(815_000_000 + i * 0.1)));
                    out_.Append('\n');
                }
            }
        }
        return out_.ToString();
    }

    public static string Traits()
    {
        var out_ = new StringBuilder();
        var rng = new SplitMix(42);
        for (var i = 0; i < 3000; i++)
        {
            var t = RandomTraits(ref rng);
            var pet = PixelPet.Make(t);
            var g = PixelPet.Growth(t);
            var ranked = string.Join(',', PixelPet.RankedGenres(t.Genres).Select(r => r.ToRaw()));
            out_.Append($"{pet.Code} {pet.Name} | {pet.Blurb} | {pet.AccessibilityDescription} | ");
            out_.Append($"{Hex(BitConverter.DoubleToUInt64Bits(g.Experience))} {I(g.Level)} {g.Stage.ToRaw()} {g.NextStage?.ToRaw() ?? "-"} ");
            out_.Append($"{Hex(BitConverter.DoubleToUInt64Bits(g.ExperienceToNextStage))} {Hex(BitConverter.DoubleToUInt64Bits(g.Progress))} | {ranked}\n");
        }
        return out_.ToString();
    }

    public static string Genres()
    {
        var out_ = new StringBuilder();
        for (var i = 0; i < GenreNames.Length; i++)
        {
            out_.Append($"{I(i)} {PetGenre.FromName(GenreNames[i])?.ToRaw() ?? "-"}\n");
        }
        foreach (var genre in Enum.GetValues<PetGenre>())
        {
            out_.Append($"{genre.ToRaw()} {genre.Label} {genre.Species.ToRaw()} {genre.Accessory.ToRaw()} {genre.Tone.ToRaw()}\n");
        }
        return out_.ToString();
    }

    public static string Codes()
    {
        const string alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
        var inputs = new List<string>
        {
            "", "p1-", "p1", "hello world", "p1-!!!!!!!!!!", "p1-0000000000", "p1-iiiiiiiiii", "\U0001F98A\U0001F98A\U0001F98A",
            new('z', 500), "p1-\0\0\0\0\0\0\0\0\0\0",
            "p1-\U0001F98A\U0001F98A\U0001F98A\U0001F98A\U0001F98A", "p1-\u212A000000000",
        };
        foreach (var check in alphabet)
        {
            inputs.Add("p1-z0000010a" + check);
            inputs.Add("p1-00000" + "00" + "00" + check);
            inputs.Add("p1-00000" + "38" + "00" + check);
            inputs.Add("p1-00000" + "01" + "00" + check);
            inputs.Add("p1-e3i30" + "33" + "zz" + check);
        }
        foreach (var pet in TraitPets().Take(40))
        {
            var code = pet.Code;
            inputs.AddRange([
                code.ToUpperInvariant(), " \t" + code + "\n", "\u00A0" + code + "\u2028", "\u200B" + code, code + "\u0085",
                "\uFEFF" + code, "\u1680" + code + "\r\n", code[..^1], code + "0",
                "p1_" + code[3..], "P1-" + code[3..], "p2-" + code[3..],
            ]);
            var chars = code.ToCharArray();
            for (var i = 3; i < chars.Length; i++)
            {
                foreach (var c in alphabet)
                {
                    if (c == chars[i]) continue;
                    var changed = (char[])chars.Clone();
                    changed[i] = c;
                    inputs.Add(new string(changed));
                }
            }
        }
        var out_ = new StringBuilder();
        for (var i = 0; i < inputs.Count; i++)
        {
            out_.Append($"{I(i)} {PixelPet.FromCode(inputs[i])?.Code ?? "nil"}\n");
        }
        return out_.ToString();
    }

    public static string Bounds()
    {
        var out_ = new StringBuilder();
        foreach (var s in Enum.GetValues<PetSpecies>())
        foreach (var st in Enum.GetValues<PetStage>())
        foreach (var a in Enum.GetValues<PetAccessory>())
        {
            var pet = new PixelPet(s, st, a);
            var b = pet.ContentBounds;
            out_.Append($"{pet.Code} {I(b.X)},{I(b.Y)},{I(b.W)},{I(b.H)}");
            for (var pixels = 0; pixels <= 200; pixels++)
            {
                var c = PixelPet.TightCrop(b, pixels);
                out_.Append($" {I(c.X)},{I(c.Y)},{I(c.Side)}");
            }
            out_.Append('\n');
        }
        return out_.ToString();
    }

    public static string Art()
    {
        var out_ = new StringBuilder();
        foreach (var s in Enum.GetValues<PetSpecies>())
        {
            foreach (var st in new[] { PetStage.Baby, PetStage.Teen, PetStage.Adult })
            {
                var sprite = PetArt.SpriteFor(s, st);
                out_.Append($"{s.ToRaw()} {st.ToRaw()} {I(sprite.Width)}x{I(sprite.Height)} head {I(sprite.Head.X)},{I(sprite.Head.Y)}");
                out_.Append($" neck {I(sprite.Neck)} hand {I(sprite.Hand.X)},{I(sprite.Hand.Y)} half {I(sprite.HeadHalfWidth)}");
                out_.Append($" mouth {(sprite.Mouth is { } m ? $"{I(m.X)},{I(m.Y)}" : "-")}");
                out_.Append(" eyes " + string.Join(';', sprite.Eyes.Select(e => $"{I(e.X)},{I(e.Y)},{I(e.W)},{I(e.H)}")));
                out_.Append($" rect {(sprite.IsRectangular ? "true" : "false")}\n");
                for (var y = 0; y < sprite.Height; y++)
                {
                    var row = Enumerable.Range(0, sprite.Width).Select(x => sprite.Key(x, y)).ToArray();
                    out_.Append(Encoding.UTF8.GetString(row)).Append('\n');
                }
            }
            foreach (var tone in Enum.GetValues<PetTone>())
            {
                var palette = PetArt.Palette(s, tone);
                out_.Append($"{s.ToRaw()} {tone.ToRaw()} ")
                    .Append(string.Join(',', palette.Select(p => p.ToString("x", CultureInfo.InvariantCulture))))
                    .Append('\n');
            }
        }
        return out_.ToString();
    }

    public static readonly double[] ViewSizes = [20.64, 24, 28, 37.84, 40, 44, 120, 150, 168];

    /// <summary>What PixelPetView puts on screen, as premultiplied BGRA (the Mac side renders the SwiftUI view).</summary>
    public static string Views()
    {
        PixelPet[] pets =
        [
            .. SamplePets,
            new(PetSpecies.Bunny, PetStage.Adult, PetAccessory.WizardHat, PetTone.Sunny, PetMood.Happy, level: 30, nameIndex: 512),
        ];
        var out_ = new StringBuilder();
        foreach (var pet in pets)
        foreach (var size in ViewSizes)
        foreach (var scale in new[] { 1.0, 2.0 })
        foreach (var framing in new[] { PetFraming.Automatic, PetFraming.Stage, PetFraming.Tight })
        foreach (var time in new[] { 0.0, 1.7 })
        {
            var frame = PetCanvas.FrameFor(pet, size, framing, time: time);
            var image = PetCanvas.Render(pet, frame, size, scale, framing);
            var f = framing switch { PetFraming.Automatic => "auto", PetFraming.Stage => "stage", _ => "tight" };
            out_.Append($"{pet.Code} {SwiftDouble(size)} {SwiftDouble(scale)} {f} {SwiftDouble(time)} ");
            out_.Append($"{I(image.PixelWidth)}x{I(image.PixelHeight)} {Hex(FnvBytes(image.Bgra))}\n");
        }
        return out_.ToString();
    }

    /// <summary>Writes every section to <paramref name="dir"/>, named like the Swift tool's output.</summary>
    public static void WriteAll(string dir)
    {
        Directory.CreateDirectory(dir);
        foreach (var (name, make) in Sections) File.WriteAllText(Path.Combine(dir, name + ".txt"), make());
    }
}
