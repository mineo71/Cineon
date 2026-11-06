using System.Text.Json;
using Cineon.Core.Profile;

namespace Cineon.Core.Tests.Profile;

/// <summary>Port of CineonTests/PixelPetTests.swift, same cases and expectations.</summary>
public class PixelPetTests
{
    // MARK: Helpers

    /// <summary>Small deterministic generator so failures are reproducible.</summary>
    private sealed class SplitMix(ulong state)
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

        /// <summary>Uniform in lo...hi (inclusive).</summary>
        public int Int(int lo, int hi) => lo + (int)(Next() % (ulong)(hi - lo + 1));

        public double Double(double lo, double hi) => lo + (Next() >> 11) * (1.0 / (1UL << 53)) * (hi - lo);

        public bool Bool() => (Next() & 1) == 1;

        public void Shuffle<T>(IList<T> list)
        {
            for (var i = list.Count - 1; i > 0; i--)
            {
                var j = Int(0, i);
                (list[i], list[j]) = (list[j], list[i]);
            }
        }
    }

    private static readonly string[] GenreNames =
    [
        "Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi", "Mystery",
        "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History", "Family", "Short",
        "Western", "Music", "Documentary", "Musical", "Reality-TV", "Talk-Show", "Game-Show", "News",
        "Film-Noir", "Science Fiction", "Bollywood", "", "Action & Adventure",
    ];

    private static PetTraits RandomTraits(SplitMix rng)
    {
        var count = rng.Int(0, 6);
        var genres = Enumerable.Range(0, count)
            .Select(_ => new GenreWeight(GenreNames[rng.Int(0, GenreNames.Length - 1)], rng.Int(-2, 50)))
            .ToList();
        var bytes = new byte[16];
        bytes[0] = (byte)rng.Int(0, 255);
        for (var i = 1; i < 15; i++) bytes[i] = (byte)i;
        bytes[15] = (byte)rng.Int(0, 255);
        return new PetTraits
        {
            Genres = genres,
            HoursWatched = rng.Double(0, 3000),
            TitlesFinished = rng.Int(0, 2000),
            DaysSinceLastWatch = rng.Bool() ? null : rng.Int(-3, 400),
            Seed = PetTraits.SeedFor(new Guid(bytes, bigEndian: true)),
        };
    }

    private static PetTraits Traits(
        (string Name, double Weight)[] genres, double hours = 0, int titles = 0, int? days = 0,
        string seed = "8E1F3C1A-7A43-4C1B-9C0B-2B7D1D6C9A11") => new()
    {
        Genres = genres.Select(g => new GenreWeight(g.Name, g.Weight)).ToList(),
        HoursWatched = hours,
        TitlesFinished = titles,
        DaysSinceLastWatch = days,
        Seed = seed,
    };

    private static int Opaque(PetBitmap bitmap) => bitmap.Pixels.Count(p => p != 0);

    // MARK: Determinism

    [Fact]
    public void SameTraitsGiveSamePetAndCode()
    {
        var rng = new SplitMix(1);
        for (var i = 0; i < 200; i++)
        {
            var t = RandomTraits(rng);
            PixelPet a = PixelPet.Make(t), b = PixelPet.Make(t);
            Assert.Equal(a, b);
            Assert.Equal(a.Code, b.Code);
            Assert.Equal(a.Name, b.Name);
            Assert.Equal(a.Blurb, b.Blurb);
        }
    }

    [Fact]
    public void GenreOrderDoesNotMatter()
    {
        var rng = new SplitMix(2);
        for (var i = 0; i < 200; i++)
        {
            var t = RandomTraits(rng);
            var pet = PixelPet.Make(t);
            var shuffled = t.Genres.ToList();
            rng.Shuffle(shuffled);
            Assert.Equal(pet, PixelPet.Make(t with { Genres = shuffled }));
        }
    }

    [Fact]
    public void KnownSeedGivesKnownName()
    {
        // FNV-1a is stable across launches; this pins the name tables and hash.
        var pet = PixelPet.Make(Traits([("Horror", 3)], seed: "seed-a"));
        Assert.Equal(PixelPet.NameIndexFor("seed-a", PetSpecies.Ghost), pet.NameIndex);
        Assert.Equal(0xaf63_dc4c_8601_ec8cUL, PixelPet.StableHash("a"));
        Assert.Equal(0xcbf2_9ce4_8422_2325UL, PixelPet.StableHash(""));
    }

    // MARK: Codes

    [Fact]
    public void CodeRoundTripsForRandomTraits()
    {
        var rng = new SplitMix(3);
        const string allowed = "0123456789abcdefghjkmnpqrstvwxyz-";
        for (var i = 0; i < 1000; i++)
        {
            var pet = PixelPet.Make(RandomTraits(rng));
            var code = pet.Code;
            Assert.StartsWith("p1-", code);
            Assert.True(code.Length <= 40);
            Assert.True(code.All(allowed.Contains), code);
            Assert.Equal(pet, PixelPet.FromCode(code));
        }
    }

    [Fact]
    public void CodeRoundTripsForEveryCombination()
    {
        foreach (var species in Enum.GetValues<PetSpecies>())
        foreach (var stage in Enum.GetValues<PetStage>())
        foreach (var accessory in Enum.GetValues<PetAccessory>())
        foreach (var tone in Enum.GetValues<PetTone>())
        foreach (var mood in Enum.GetValues<PetMood>())
        foreach (var (level, name) in new[] { (1, 0), (99, 1023), (42, 517) })
        {
            var pet = new PixelPet(species, stage, accessory, tone, mood, level, name);
            Assert.Equal(pet, PixelPet.FromCode(pet.Code));
        }
    }

    [Fact]
    public void CodeIsTolerantOfCaseAndWhitespace()
    {
        var pet = PixelPet.Make(Traits([("Sci-Fi", 4)], titles: 30));
        Assert.Equal(pet, PixelPet.FromCode("  " + pet.Code.ToUpperInvariant() + "\n"));
    }

    [Fact]
    public void CodeRejectsGarbage()
    {
        var pet = PixelPet.Make(Traits([("Comedy", 4)], titles: 30));
        var code = pet.Code;
        string[] rejects =
        [
            "", "p1-", "p1", "p2-" + code[3..], "p0-" + code[3..], code + "0",
            code[..^1], "hello world", "p1-!!!!!!!!!!", "p1-0000000000", "p1-iiiiiiiiii",
            "\U0001F98A\U0001F98A\U0001F98A", new string('z', 500), "p1-\0\0\0\0\0\0\0\0\0\0",
        ];
        foreach (var text in rejects) Assert.True(PixelPet.FromCode(text) is null, $"accepted {text}");
        Assert.Null(PixelPet.FromCode(null));
        // Any single-character change breaks the checksum or a range check (or is another valid pet).
        const string alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
        var chars = code.ToCharArray();
        for (var i = 3; i < chars.Length; i++)
        {
            var original = chars[i];
            foreach (var c in alphabet)
            {
                if (c == original) continue;
                chars[i] = c;
                if (PixelPet.FromCode(new string(chars)) is { } other) Assert.NotEqual(pet, other);
            }
            chars[i] = original;
        }
    }

    [Fact]
    public void CodeRejectsOutOfRangeFieldsEvenWithValidChecksum()
    {
        const string alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
        // Species "z" (31) does not exist; try every possible checksum character.
        foreach (var check in alphabet)
        {
            Assert.Null(PixelPet.FromCode("p1-z0000010a" + check));
            Assert.Null(PixelPet.FromCode("p1-00000" + "00" + "00" + check)); // level 0
            Assert.Null(PixelPet.FromCode("p1-00000" + "38" + "00" + check)); // level 104
        }
    }

    [Fact]
    public void CodableUsesCode()
    {
        var pet = PixelPet.Make(Traits([("Fantasy", 9), ("Romance", 3)], titles: 90, days: 3));
        var json = JsonSerializer.Serialize(new[] { pet });
        Assert.Equal($"[\"{pet.Code}\"]", json);
        Assert.Equal([pet], JsonSerializer.Deserialize<PixelPet[]>(json)!);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<PixelPet[]>("[\"nope\"]"));
    }

    // MARK: Genres

    [Fact]
    public void FavouriteGenreDrivesSpecies()
    {
        (string, PetSpecies)[] cases =
        [
            ("Horror", PetSpecies.Ghost), ("Action", PetSpecies.Fox), ("Adventure", PetSpecies.Turtle), ("Drama", PetSpecies.Cat),
            ("Comedy", PetSpecies.Frog), ("Crime", PetSpecies.Raccoon), ("Thriller", PetSpecies.Raven), ("Sci-Fi", PetSpecies.Robot),
            ("Science Fiction", PetSpecies.Robot), ("sci fi", PetSpecies.Robot), ("Fantasy", PetSpecies.Dragon), ("Mystery", PetSpecies.Owl),
            ("Documentary", PetSpecies.Owl), ("Biography", PetSpecies.Owl), ("History", PetSpecies.Owl), ("Animation", PetSpecies.Slime),
            ("Romance", PetSpecies.Bunny), ("Family", PetSpecies.Puppy), ("Sport", PetSpecies.Puppy), ("Western", PetSpecies.Raccoon),
            ("Music", PetSpecies.Songbird), ("Musical", PetSpecies.Songbird), ("War", PetSpecies.Hedgehog), ("Film-Noir", PetSpecies.Raccoon),
            ("Reality-TV", PetSpecies.Frog), ("Talk-Show", PetSpecies.Frog), ("Game-Show", PetSpecies.Frog), ("News", PetSpecies.Owl),
            ("Short", PetSpecies.Slime), ("HORROR", PetSpecies.Ghost), ("  thriller ", PetSpecies.Raven),
        ];
        foreach (var (name, species) in cases)
        {
            Assert.Equal(species, PixelPet.Make(Traits([(name, 1)])).Species);
            var filler = name == "Drama" ? "Comedy" : "Drama";
            Assert.Equal(species, PixelPet.Make(Traits([(filler, 3), (name, 10)])).Species);
        }
        var horrorFan = Traits([("Comedy", 4), ("Horror", 25), ("Drama", 7), ("Thriller", 3)]);
        Assert.Equal(PetSpecies.Ghost, PixelPet.Make(horrorFan).Species);
        Assert.Equal("Ghost", PixelPet.Make(horrorFan).SpeciesLabel);
    }

    [Fact]
    public void AliasesMergeBeforeRanking()
    {
        // "Sci-Fi" 3 + "Science Fiction" 3 beats "Action" 5.
        var pet = PixelPet.Make(Traits([("Action", 5), ("Sci-Fi", 3), ("Science Fiction", 3)]));
        Assert.Equal(PetSpecies.Robot, pet.Species);
        Assert.Equal(PetAccessory.Headband, pet.Accessory);
    }

    [Fact]
    public void TiesBreakByCommonness()
    {
        var pet = PixelPet.Make(Traits([("Horror", 5), ("Action", 5)]));
        Assert.Equal(PetSpecies.Fox, pet.Species);
        Assert.Equal(PetAccessory.Horns, pet.Accessory);
    }

    [Fact]
    public void SecondGenrePicksAccessoryAndThirdPicksTone()
    {
        var pet = PixelPet.Make(Traits([("Horror", 10), ("Sci-Fi", 6), ("Comedy", 2)]));
        Assert.Equal(PetSpecies.Ghost, pet.Species);
        Assert.Equal(PetAccessory.Glasses3D, pet.Accessory);
        Assert.Equal(PetTone.Sunny, pet.Tone);
        foreach (var genre in Enum.GetValues<PetGenre>())
        {
            var p = PixelPet.Make(Traits([("Drama", 10), (genre.ToRaw(), 5), ("Horror", 1)]));
            if (genre != PetGenre.Drama) Assert.Equal(genre.Accessory, p.Accessory);
        }
    }

    [Fact]
    public void UnknownAndEmptyGenresStillMakeAValidPet()
    {
        (string, double)[][] inputs =
        [
            [], [("Bollywood", 10)], [("", 3)], [("Horror", 0)], [("Horror", -4)], [("Horror", double.NaN)],
            [("Horror", double.PositiveInfinity)], [("???", 1), ("Telenovela", 2)],
        ];
        foreach (var genres in inputs)
        {
            var pet = PixelPet.Make(Traits(genres));
            Assert.Equal(PetSpecies.Slime, pet.Species);
            Assert.Equal(PetAccessory.None, pet.Accessory);
            Assert.Equal(pet, PixelPet.FromCode(pet.Code));
            Assert.NotEmpty(pet.Name);
            Assert.NotEmpty(pet.Blurb);
            Assert.NotEqual(0, Opaque(pet.Bitmap()));
        }
        // Unknown names next to a known one are ignored.
        Assert.Equal(PetSpecies.Hedgehog, PixelPet.Make(Traits([("Bollywood", 50), ("War", 1)])).Species);
        // Combined names split into their parts.
        Assert.Equal(PetSpecies.Robot, PixelPet.Make(Traits([("Sci-Fi & Fantasy", 10), ("Drama", 4)])).Species);
    }

    // MARK: Stage, level, mood

    [Fact]
    public void StageThresholds()
    {
        (double, int, PetStage)[] cases =
        [
            (0, 0, PetStage.Baby), (9.99, 0, PetStage.Baby), (10, 0, PetStage.Teen), (0, 6, PetStage.Baby), (0, 7, PetStage.Teen),
            (59.9, 0, PetStage.Teen), (60, 0, PetStage.Adult), (0, 40, PetStage.Adult), (199.9, 0, PetStage.Adult), (200, 0, PetStage.Legend),
            (0, 133, PetStage.Adult), (0, 134, PetStage.Legend), (0, 240, PetStage.Legend), (5000, 900, PetStage.Legend),
            (-50, -3, PetStage.Baby), (double.NaN, 0, PetStage.Baby), (double.PositiveInfinity, 0, PetStage.Baby),
        ];
        foreach (var (hours, titles, stage) in cases)
        {
            var pet = PixelPet.Make(Traits([("Drama", 1)], hours: hours, titles: titles));
            Assert.Equal(stage, pet.Stage);
            Assert.Equal(stage.Label, pet.StageLabel);
        }
        Assert.Equal(["Baby", "Teen", "Adult", "Legend"], Enum.GetValues<PetStage>().Select(s => s.Label));
        Assert.True(PetStage.Baby < PetStage.Teen && PetStage.Adult < PetStage.Legend);
    }

    [Fact]
    public void Levels()
    {
        Assert.Equal(1, PixelPet.Make(Traits([], hours: 0, titles: 0)).Level);
        Assert.Equal(2, PixelPet.Make(Traits([], hours: 3, titles: 0)).Level);
        Assert.Equal(19, PixelPet.Make(Traits([], hours: 0, titles: 240)).Level); // xp 360
        Assert.Equal(99, PixelPet.Make(Traits([], hours: 1e9, titles: 0)).Level);
        var last = 0;
        for (var i = 0; i * 7.5 <= 10_000; i++)
        {
            var level = PixelPet.LevelForExperience(i * 7.5);
            Assert.True(level >= last);
            Assert.InRange(level, 1, 99);
            last = level;
        }
    }

    [Fact]
    public void GrowthProgress()
    {
        var g = PixelPet.Growth(Traits([], hours: 0, titles: 20)); // xp 30
        Assert.Equal(PetStage.Teen, g.Stage);
        Assert.Equal(PetStage.Adult, g.NextStage);
        Assert.Equal(30, g.ExperienceToNextStage, 1e-9);
        Assert.Equal(0.4, g.Progress, 1e-9);
        var legend = PixelPet.Growth(Traits([], titles: 240));
        Assert.Null(legend.NextStage);
        Assert.Equal(1, legend.Progress);
    }

    [Fact]
    public void MoodThresholds()
    {
        (int?, PetMood)[] cases =
        [
            (null, PetMood.Sleepy), (-2, PetMood.Happy), (0, PetMood.Happy), (1, PetMood.Happy), (2, PetMood.Content),
            (5, PetMood.Content), (6, PetMood.Bored), (14, PetMood.Bored), (15, PetMood.Sleepy), (365, PetMood.Sleepy),
        ];
        foreach (var (days, mood) in cases)
        {
            Assert.Equal(mood, PixelPet.Make(Traits([("Comedy", 1)], days: days)).Mood);
        }
        Assert.Equal("Sleepy", PetMood.Sleepy.Label);
        Assert.Equal("Happy", PetMood.Happy.Label);
    }

    [Fact]
    public void RealLibraryShape()
    {
        // Counts from the real library, most first; ~0 tracked hours, 240 finished titles.
        string[] names =
        [
            "Action", "Drama", "Adventure", "Crime", "Comedy", "Thriller", "Fantasy", "Sci-Fi",
            "Mystery", "Horror", "Animation", "Biography", "War", "Sport", "Romance", "History",
            "Family", "Short", "Western", "Music", "Documentary",
        ];
        var genres = names.Select((name, offset) => (name, (double)(120 - offset * 5))).ToArray();
        var pet = PixelPet.Make(Traits(genres, hours: 0.4, titles: 240, days: 1));
        Assert.Equal(PetSpecies.Fox, pet.Species);
        Assert.Equal(PetAccessory.Scarf, pet.Accessory);
        Assert.Equal(PetTone.Sunny, pet.Tone);
        Assert.Equal(PetStage.Legend, pet.Stage);
        Assert.Equal(PetMood.Happy, pet.Mood);
        Assert.Equal(19, pet.Level);
    }

    // MARK: Names and text

    [Fact]
    public void NamesAreShortAndClean()
    {
        string[] blocked =
        [
            "ass", "cum", "fag", "gay", "jap", "kike", "loli", "nazi", "nig", "paki", "pedo", "piss",
            "poo", "porn", "puta", "puto", "rape", "sex", "shit", "slut", "tit", "fuk", "coon", "homo",
            "suki", "chichi", "hui", "huj", "pizd", "blya", "gay",
        ];
        var names = new HashSet<string>();
        for (var index = 0; index < PixelPet.NameCount; index++)
        {
            var name = new PixelPet(PetSpecies.Cat, PetStage.Baby, nameIndex: index).Name;
            names.Add(name);
            Assert.InRange(name.Length, 3, 7);
            Assert.True(char.IsUpper(name[0]), name);
            foreach (var bad in blocked) Assert.DoesNotContain(bad, name.ToLowerInvariant());
        }
        Assert.True(names.Count > 900);
        Assert.Equal(PixelPet.NameCount, PixelPet.NameHeads.Count * PixelPet.NameTails.Count);
    }

    [Fact]
    public void LabelsAndBlurbsExist()
    {
        foreach (var species in Enum.GetValues<PetSpecies>())
        {
            for (var index = 0; index < 6; index++)
            {
                var pet = new PixelPet(species, PetStage.Adult, nameIndex: index);
                Assert.NotEmpty(pet.SpeciesLabel);
                Assert.NotEmpty(pet.Blurb);
                Assert.True(pet.Blurb.Length <= 70, pet.Blurb);
                Assert.Contains(pet.Name, pet.AccessibilityDescription);
            }
        }
    }

    // MARK: Art

    [Fact]
    public void EverySpriteIsRectangularAndUsesKnownKeys()
    {
        var allowed = PetArt.SpriteKeys.Union(PetArt.SharedKeys).ToHashSet();
        var beaked = new HashSet<PetSpecies> { PetSpecies.Raven, PetSpecies.Owl, PetSpecies.Songbird };
        foreach (var species in Enum.GetValues<PetSpecies>())
        {
            foreach (var stage in Enum.GetValues<PetStage>())
            {
                var sprite = PetArt.SpriteFor(species, stage);
                var label = $"{species} {stage}";
                Assert.True(sprite.IsRectangular, label);
                Assert.Equal(sprite.Width * sprite.Height, sprite.Keys.Length);
                Assert.Equal(2, sprite.Eyes.Count);
                foreach (var eye in sprite.Eyes) Assert.Equal(4, eye.W * eye.H);
                if (!beaked.Contains(species)) Assert.True(sprite.Mouth is not null, label);
                // Fits the 24×24 canvas when placed.
                var left = PetArt.CenterX - sprite.Head.X;
                Assert.True(left >= 0, label);
                Assert.True(left + sprite.Width <= PetBitmap.Size, label);
                Assert.True(sprite.Height <= PetBitmap.Size, label);
                Assert.InRange(sprite.Head.Y, 0, sprite.Height - 1);
                Assert.InRange(sprite.Neck, 0, sprite.Height - 1);
                foreach (var key in sprite.Keys) Assert.True(allowed.Contains((char)key), $"{label} uses {(char)key}");
                foreach (var tone in Enum.GetValues<PetTone>())
                {
                    var palette = PetArt.Palette(species, tone);
                    foreach (var key in sprite.Keys.ToHashSet())
                    {
                        if (key == PetArt.K('.') || key == PetArt.K('E')) continue;
                        Assert.True(palette[key] != 0, $"{label} {tone} lacks {(char)key}");
                    }
                    foreach (var key in "eiowt") Assert.NotEqual(0u, palette[PetArt.K(key)]);
                }
            }
        }
    }

    [Fact]
    public void EveryOverlayIsRectangularAndUsesKnownKeys()
    {
        var allowed = PetArt.SpriteKeys.Union(PetArt.SharedKeys).ToHashSet();
        foreach (var (name, overlay) in PetArt.AllOverlays)
        {
            Assert.True(overlay.IsRectangular, name);
            Assert.True(overlay.Width * overlay.Height > 0, name);
            foreach (var key in overlay.Keys) Assert.True(allowed.Contains((char)key), $"{name} uses {(char)key}");
        }
        foreach (var accessory in Enum.GetValues<PetAccessory>())
        {
            if (accessory.IsHat && accessory != PetAccessory.Headphones) Assert.True(PetArt.Hats.ContainsKey(accessory), accessory.ToRaw());
        }
    }

    [Fact]
    public void EveryCombinationRenders()
    {
        foreach (var species in Enum.GetValues<PetSpecies>())
        {
            foreach (var stage in Enum.GetValues<PetStage>())
            {
                var bare = new PixelPet(species, stage).Bitmap();
                foreach (var accessory in Enum.GetValues<PetAccessory>())
                {
                    foreach (var mood in Enum.GetValues<PetMood>())
                    {
                        var pet = new PixelPet(species, stage, accessory, mood: mood);
                        foreach (var t in new[] { 0.0, 0.25, 0.9, 1.7, 3.1, 4.4 })
                        {
                            Assert.Equal(576, pet.Bitmap(pet.FrameAt(t)).Pixels.Length);
                        }
                        var still = pet.Bitmap();
                        Assert.True(Opaque(still) > 60, $"{species} {stage}");
                        if (accessory != PetAccessory.None && !(stage == PetStage.Legend && accessory.IsHat))
                        {
                            Assert.True(!still.Equals(new PixelPet(species, stage, mood: mood).Bitmap()),
                                $"{accessory} invisible on {species} {stage}");
                        }
                    }
                }
                // Babies are smaller than adults.
                if (stage == PetStage.Baby)
                {
                    var adult = new PixelPet(species, PetStage.Adult).Bitmap();
                    Assert.True(Opaque(bare) < Opaque(adult));
                }
            }
        }
    }

    [Fact]
    public void Frames()
    {
        var sleepy = new PixelPet(PetSpecies.Owl, PetStage.Teen, mood: PetMood.Sleepy);
        var legend = new PixelPet(PetSpecies.Fox, PetStage.Legend, mood: PetMood.Happy);
        for (var i = 0; i < 200; i++)
        {
            var t = i * 0.1;
            Assert.Equal(PetEyes.Closed, sleepy.FrameAt(t).Eyes);
            Assert.Equal(PetEffect.Zzz, sleepy.FrameAt(t).Effect);
            Assert.NotNull(legend.FrameAt(t).Sparkle);
            Assert.Null(sleepy.FrameAt(t).Sparkle);
            Assert.InRange(legend.FrameAt(t).Lift, 0, 3);
            Assert.Equal(legend.FrameAt(t), legend.FrameAt(t));
        }
        var content = new PixelPet(PetSpecies.Cat, PetStage.Adult, mood: PetMood.Content);
        var eyes = Enumerable.Range(0, 200).Select(i => content.FrameAt(i * 0.05).Eyes).ToHashSet();
        Assert.Equal(new HashSet<PetEyes> { PetEyes.Open, PetEyes.Closed }, eyes); // it blinks
        Assert.Equal(PetEffect.Dots, new PixelPet(PetSpecies.Cat, PetStage.Adult, mood: PetMood.Bored).RestingFrame.Effect);
        Assert.Equal(PetEyes.Closed, sleepy.RestingFrame.Eyes);
        Assert.Equal(0, content.RestingFrame.Lift);
    }

    [Fact]
    public void TightCropStaysInsideCanvas()
    {
        foreach (var species in Enum.GetValues<PetSpecies>())
        {
            foreach (var stage in Enum.GetValues<PetStage>())
            {
                var pet = new PixelPet(species, stage, PetAccessory.WizardHat);
                var bounds = pet.ContentBounds;
                foreach (var pixels in new[] { 12, 16, 24, 32, 40, 48, 56, 72, 96, 200 })
                {
                    var crop = PixelPet.TightCrop(bounds, pixels);
                    Assert.InRange(crop.Side, 12, 24);
                    Assert.True(crop.X >= 0);
                    Assert.True(crop.Y >= 0);
                    Assert.True(crop.X + crop.Side <= 24);
                    Assert.True(crop.Y + crop.Side <= 24);
                }
            }
        }
    }

    // MARK: Windows additions

    [Fact]
    public void TwinklePhaseNeverLeavesTheTable()
    {
        // On the Mac, name 335 at 0.25 s rounds the Legend twinkle phase up to 6 and the renderer traps.
        var pet = new PixelPet(PetSpecies.Fox, PetStage.Legend, nameIndex: 335);
        Assert.Equal(5, pet.FrameAt(0.25).Sparkle);
        Assert.Equal(576, pet.Bitmap(pet.FrameAt(0.25)).Pixels.Length);
    }

    [Fact]
    public void RawValuesAreTheSwiftCaseNames()
    {
        Assert.Equal("glasses3D", PetAccessory.Glasses3D.ToRaw());
        Assert.Equal("explorerHat", PetAccessory.ExplorerHat.ToRaw());
        Assert.Equal("sciFi", PetGenre.SciFi.ToRaw());
        Assert.Equal("realityTV", PetGenre.RealityTV.ToRaw());
        Assert.Equal("songbird", PetSpecies.Songbird.ToRaw());
        Assert.Equal(PetAccessory.CowboyHat, PetAccessory.FromRaw("cowboyHat"));
        Assert.Null(PetSpecies.FromRaw("Fox"));
        foreach (var genre in Enum.GetValues<PetGenre>()) Assert.Equal(genre, PetGenre.FromRaw(genre.ToRaw()));
        Assert.Equal("Sci-Fi", PetGenre.SciFi.Label);
        Assert.Equal("Documentary", PetGenre.Documentary.Label);
    }

    [Fact]
    public void SeedIsTheMacsUpperCaseUuid()
    {
        var id = Guid.Parse("8e1f3c1a-7a43-4c1b-9c0b-2b7d1d6c9a11");
        Assert.Equal("8E1F3C1A-7A43-4C1B-9C0B-2B7D1D6C9A11", PetTraits.SeedFor(id));
    }

    [Fact]
    public void CanvasDrawsWholeDevicePixels()
    {
        var pet = new PixelPet(PetSpecies.Fox, PetStage.Adult, PetAccessory.Scarf);
        // 168 DIPs at 1.5×: 252 device pixels, 10 per cell on the whole 24×24 stage, 6 left over each side.
        var frame = PetCanvas.FrameFor(pet, 168, animated: false);
        var image = PetCanvas.Render(pet, frame, 168, 1.5);
        Assert.Equal(252, image.PixelWidth);
        Assert.Equal(252 * 252 * 4, image.Bgra.Length);
        var rects = PetCanvas.DeviceRects(pet.Bitmap(frame), PetCrop.Canvas, 168, 168, 1.5);
        Assert.All(rects, r =>
        {
            Assert.Equal(0, (r.X0 - 6) % 10);
            Assert.Equal(0, (r.Y0 - 6) % 10);
        });
        // Every opaque cell becomes a 10×10 block of its colour, premultiplied BGRA.
        var bitmap = pet.Bitmap(frame);
        for (var y = 0; y < 24; y++)
        {
            for (var x = 0; x < 24; x++)
            {
                var offset = ((6 + y * 10) * 252 + 6 + x * 10) * 4;
                var argb = bitmap[x, y];
                Assert.Equal(argb == 0 ? 0 : 255, image.Bgra[offset + 3]);
                if (argb != 0) Assert.Equal((byte)(argb >> 16), image.Bgra[offset + 2]);
            }
        }
        // Small avatars crop to the pet and drop floating effects.
        Assert.True(PetCanvas.IsTight(28, PetFraming.Automatic));
        Assert.False(PetCanvas.IsTight(40, PetFraming.Automatic));
        var sleepy = new PixelPet(PetSpecies.Cat, PetStage.Adult, mood: PetMood.Sleepy);
        Assert.Equal(PetEffect.None, PetCanvas.FrameFor(sleepy, 28, animated: false).Effect);
        Assert.Equal(PetEffect.Zzz, PetCanvas.FrameFor(sleepy, 120, animated: false).Effect);
        Assert.Equal(24 * 24 * 4, pet.Bitmap().ToBgra().Length);
    }
}
