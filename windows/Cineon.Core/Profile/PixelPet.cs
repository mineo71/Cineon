// Port of Cineon/Profile/PixelPet.swift: the model, its shareable code, the generator, the animation
// poses and the 24×24 renderer. The Swift view (PixelPetView/PetCanvas) is ported as data in PetCanvas.cs.
//
// Showing a pet in WinUI (Cineon.App does this; Core has no UI types):
//
//  1. Get the pet: `PixelPet.Make(stats.PetTraits(PetTraits.SeedFor(profile.Id)))` for yourself (the seed
//     is the profile UUID in upper case, as Swift's `uuidString`, so a Mac profile gets the same pet),
//     or `PixelPet.FromCode(code)` for a friend's code from the Together server (null: show their initial).
//  2. Each tick, ask for the pose: `var frame = PetCanvas.FrameFor(pet, size, framing, animated,
//     reduceMotion: !new UISettings().AnimationsEnabled, time: null, now: PetCanvas.Now())`.
//     Tick every `PetCanvas.FrameInterval` (100 ms, the Mac's TimelineView minimumInterval) with a
//     DispatcherQueueTimer, and only while the element is loaded and animated. Redraw only when `frame`
//     differs from the last one (PetFrame has value equality); most ticks change nothing.
//     Not animated (avatars in the top bar and Together lists, the share card) or Reduce Motion: draw once.
//  3. Draw it, either way pixel-exact like the Mac:
//     a. WriteableBitmap: `var image = PetCanvas.Render(pet, frame, size, scale, framing)` where `scale` is
//        XamlRoot.RasterizationScale (re-render when it changes). It is a premultiplied BGRA8 buffer of
//        ceil(size × scale) device pixels square, laid out exactly as the Mac lays out that size at that
//        scale; copy `image.Bgra` into a WriteableBitmap of `image.PixelWidth × image.PixelHeight` and show
//        it in an Image (Stretch = Fill) whose Width/Height are `image.PixelWidth / scale`, so one bitmap
//        pixel is one device pixel and nothing resamples.
//     b. Win2D: `PetCanvas.Layout(pet.Bitmap(frame), PetCanvas.CropFor(pet, PetCanvas.IsTight(size, framing),
//        w, h, scale), w, h, scale)` with w, h the control's ActualWidth/ActualHeight (already rounded to
//        device pixels by layout) gives the filled rectangles, in DIPs, that the Mac's Canvas fills; fill
//        them with antialiasing off.
//     Anything that scales a bitmap instead (e.g. `PetBitmap.ToBgra()` at 24×24) must use nearest-neighbour.
//  4. Accessibility: name the element `pet.AccessibilityDescription`, role image.
//
// Framing: `PetFraming.Automatic` crops to the pet below 40 DIPs (avatars) and shows the whole 24×24 stage
// from 40 up, like PixelPetView. Sizes used on the Mac: top bar 28 (not animated), Together avatars
// 44 × 0.86 and 24 × 0.86 (not animated), rate mode 120, profile hero 168, share card 150 (not animated).

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cineon.Core.Profile;

// MARK: - Inputs

/// <summary>
/// One genre and how much of it the person watches. Any non-negative scale works
/// (title counts, hours); only the relative order matters.
/// </summary>
public readonly record struct GenreWeight(string Name, double Weight);

/// <summary>Everything the generator looks at. Same traits always give the same pet.</summary>
public sealed record PetTraits
{
    /// <summary>Any order, any weights ≥ 0 (others are ignored); may be empty.</summary>
    public IReadOnlyList<GenreWeight> Genres { get; init; } = [];
    public double HoursWatched { get; init; }
    public int TitlesFinished { get; init; }
    /// <summary><c>null</c> means the person has never watched anything.</summary>
    public int? DaysSinceLastWatch { get; init; }
    /// <summary>Stable per profile (a UUID string). Drives the name and small variations.</summary>
    public required string Seed { get; init; }

    /// <summary>The seed the Mac uses for a profile: <c>profile.id.uuidString</c>, which is upper case.</summary>
    public static string SeedFor(Guid profileId) => profileId.ToString("D").ToUpperInvariant();

    public bool Equals(PetTraits? other) =>
        other is not null && Genres.SequenceEqual(other.Genres) && HoursWatched.Equals(other.HoursWatched)
        && TitlesFinished == other.TitlesFinished && DaysSinceLastWatch == other.DaysSinceLastWatch
        && Seed == other.Seed;

    public override int GetHashCode()
    {
        var hash = new HashCode();
        foreach (var genre in Genres) hash.Add(genre);
        hash.Add(HoursWatched);
        hash.Add(TitlesFinished);
        hash.Add(DaysSinceLastWatch);
        hash.Add(Seed);
        return hash.ToHashCode();
    }
}

// MARK: - Enums
// NOTE: the order of cases in every enum below is part of the `p1` code format. Only ever append new
// cases at the end. Raw values (ToRaw/FromRaw) are the Swift case names.

public enum PetSpecies { Fox, Turtle, Cat, Frog, Raccoon, Raven, Ghost, Robot, Dragon, Owl, Slime, Bunny, Puppy, Songbird, Hedgehog }

public enum PetStage { Baby, Teen, Adult, Legend }

public enum PetMood { Happy, Content, Bored, Sleepy }

public enum PetAccessory
{
    None, Headband, ExplorerHat, Scarf, PartyHat, Fedora, Shades, Horns,
    Glasses3D, WizardHat, Magnifier, PropellerCap, Bow, Bowtie, Specs,
    Helmet, CowboyHat, Headphones, Popcorn,
}

/// <summary>Colour variant of the species palette.</summary>
public enum PetTone { Classic, Sunny, Dusk }

/// <summary>Canonical genres. Names from Cinemeta/IMDb/TMDB map onto these.</summary>
public enum PetGenre
{
    // Ordered by how common they are; also the tie-break order.
    Action, Drama, Adventure, Crime, Comedy, Thriller, Fantasy, SciFi,
    Mystery, Horror, Animation, Biography, War, Sport, Romance, History,
    Family, Short, Western, Music, Documentary, Musical, RealityTV,
    TalkShow, GameShow, News, FilmNoir,
}

internal static class PetRaw
{
    /// <summary>The Swift case name: the C# name with a lower-case first letter.</summary>
    public static string Of<T>(T value) where T : struct, Enum
    {
        var name = value.ToString();
        return char.ToLowerInvariant(name[0]) + name[1..];
    }

    public static T? Parse<T>(string raw) where T : struct, Enum
    {
        foreach (var value in Enum.GetValues<T>())
        {
            if (Of(value) == raw) return value;
        }
        return null;
    }
}

public static class PetSpeciesExtensions
{
    extension(PetSpecies species)
    {
        public string Label => species switch
        {
            PetSpecies.Fox => "Fox",
            PetSpecies.Turtle => "Turtle",
            PetSpecies.Cat => "Cat",
            PetSpecies.Frog => "Frog",
            PetSpecies.Raccoon => "Raccoon",
            PetSpecies.Raven => "Raven",
            PetSpecies.Ghost => "Ghost",
            PetSpecies.Robot => "Robot",
            PetSpecies.Dragon => "Dragon",
            PetSpecies.Owl => "Owl",
            PetSpecies.Slime => "Slime",
            PetSpecies.Bunny => "Bunny",
            PetSpecies.Puppy => "Puppy",
            PetSpecies.Songbird => "Songbird",
            PetSpecies.Hedgehog => "Hedgehog",
            _ => species.ToString(),
        };

        public string ToRaw() => PetRaw.Of(species);
    }

    extension(PetSpecies)
    {
        public static PetSpecies? FromRaw(string raw) => PetRaw.Parse<PetSpecies>(raw);
    }
}

public static class PetStageExtensions
{
    extension(PetStage stage)
    {
        public string Label => stage switch
        {
            PetStage.Baby => "Baby",
            PetStage.Teen => "Teen",
            PetStage.Adult => "Adult",
            PetStage.Legend => "Legend",
            _ => stage.ToString(),
        };

        /// <summary>Experience needed to reach this stage.</summary>
        public double MinimumExperience => stage switch
        {
            PetStage.Baby => 0,
            PetStage.Teen => 10,
            PetStage.Adult => 60,
            PetStage.Legend => 200,
            _ => 0,
        };

        public PetStage? Next => stage < PetStage.Legend ? stage + 1 : null;

        public string ToRaw() => PetRaw.Of(stage);
    }

    extension(PetStage)
    {
        public static PetStage FromExperience(double experience)
        {
            var xp = double.IsFinite(experience) ? experience : 0;
            return Enum.GetValues<PetStage>().LastOrDefault(s => xp >= s.MinimumExperience, PetStage.Baby);
        }

        public static PetStage? FromRaw(string raw) => PetRaw.Parse<PetStage>(raw);
    }
}

public static class PetMoodExtensions
{
    extension(PetMood mood)
    {
        public string Label => mood switch
        {
            PetMood.Happy => "Happy",
            PetMood.Content => "Content",
            PetMood.Bored => "Misses you",
            PetMood.Sleepy => "Sleepy",
            _ => mood.ToString(),
        };

        public string ToRaw() => PetRaw.Of(mood);
    }

    extension(PetMood)
    {
        public static PetMood FromDaysSinceLastWatch(int? days) => days switch
        {
            null => PetMood.Sleepy,
            <= 1 => PetMood.Happy,
            <= 5 => PetMood.Content,
            <= 14 => PetMood.Bored,
            _ => PetMood.Sleepy,
        };

        public static PetMood? FromRaw(string raw) => PetRaw.Parse<PetMood>(raw);
    }
}

public static class PetAccessoryExtensions
{
    extension(PetAccessory accessory)
    {
        public string Label => accessory switch
        {
            PetAccessory.None => "Nothing",
            PetAccessory.Headband => "Headband",
            PetAccessory.ExplorerHat => "Explorer hat",
            PetAccessory.Scarf => "Scarf",
            PetAccessory.PartyHat => "Party hat",
            PetAccessory.Fedora => "Fedora",
            PetAccessory.Shades => "Shades",
            PetAccessory.Horns => "Little horns",
            PetAccessory.Glasses3D => "3D glasses",
            PetAccessory.WizardHat => "Wizard hat",
            PetAccessory.Magnifier => "Magnifying glass",
            PetAccessory.PropellerCap => "Propeller cap",
            PetAccessory.Bow => "Bow",
            PetAccessory.Bowtie => "Bow tie",
            PetAccessory.Specs => "Reading glasses",
            PetAccessory.Helmet => "Helmet",
            PetAccessory.CowboyHat => "Cowboy hat",
            PetAccessory.Headphones => "Headphones",
            PetAccessory.Popcorn => "Popcorn",
            _ => accessory.ToString(),
        };

        /// <summary>Hats that a Legend's crown replaces.</summary>
        public bool IsHat => accessory is PetAccessory.ExplorerHat or PetAccessory.PartyHat or PetAccessory.Fedora
            or PetAccessory.WizardHat or PetAccessory.PropellerCap or PetAccessory.Helmet or PetAccessory.CowboyHat
            or PetAccessory.Headphones;

        public string ToRaw() => PetRaw.Of(accessory);
    }

    extension(PetAccessory)
    {
        public static PetAccessory? FromRaw(string raw) => PetRaw.Parse<PetAccessory>(raw);
    }
}

public static class PetToneExtensions
{
    extension(PetTone tone)
    {
        public string Label => tone switch
        {
            PetTone.Classic => "Classic",
            PetTone.Sunny => "Sunny",
            PetTone.Dusk => "Dusk",
            _ => tone.ToString(),
        };

        public string ToRaw() => PetRaw.Of(tone);
    }

    extension(PetTone)
    {
        public static PetTone? FromRaw(string raw) => PetRaw.Parse<PetTone>(raw);
    }
}

public static class PetGenreExtensions
{
    extension(PetGenre genre)
    {
        /// <summary>Display name, IMDb style.</summary>
        public string Label => genre switch
        {
            PetGenre.SciFi => "Sci-Fi",
            PetGenre.RealityTV => "Reality-TV",
            PetGenre.TalkShow => "Talk-Show",
            PetGenre.GameShow => "Game-Show",
            PetGenre.FilmNoir => "Film-Noir",
            _ => genre.ToString(),
        };

        public string ToRaw() => PetRaw.Of(genre);

        public PetSpecies Species => genre switch
        {
            PetGenre.Action => PetSpecies.Fox,
            PetGenre.Adventure => PetSpecies.Turtle,
            PetGenre.Drama => PetSpecies.Cat,
            PetGenre.Comedy or PetGenre.RealityTV or PetGenre.TalkShow or PetGenre.GameShow => PetSpecies.Frog,
            PetGenre.Crime or PetGenre.FilmNoir or PetGenre.Western => PetSpecies.Raccoon,
            PetGenre.Thriller => PetSpecies.Raven,
            PetGenre.Horror => PetSpecies.Ghost,
            PetGenre.SciFi => PetSpecies.Robot,
            PetGenre.Fantasy => PetSpecies.Dragon,
            PetGenre.Mystery or PetGenre.Documentary or PetGenre.Biography or PetGenre.History or PetGenre.News
                => PetSpecies.Owl,
            PetGenre.Animation or PetGenre.Short => PetSpecies.Slime,
            PetGenre.Romance => PetSpecies.Bunny,
            PetGenre.Family or PetGenre.Sport => PetSpecies.Puppy,
            PetGenre.Music or PetGenre.Musical => PetSpecies.Songbird,
            PetGenre.War => PetSpecies.Hedgehog,
            _ => PetSpecies.Slime,
        };

        public PetAccessory Accessory => genre switch
        {
            PetGenre.Action or PetGenre.Sport => PetAccessory.Headband,
            PetGenre.Adventure => PetAccessory.ExplorerHat,
            PetGenre.Drama => PetAccessory.Scarf,
            PetGenre.Comedy or PetGenre.GameShow => PetAccessory.PartyHat,
            PetGenre.Crime or PetGenre.FilmNoir => PetAccessory.Fedora,
            PetGenre.Thriller => PetAccessory.Shades,
            PetGenre.Horror => PetAccessory.Horns,
            PetGenre.SciFi => PetAccessory.Glasses3D,
            PetGenre.Fantasy => PetAccessory.WizardHat,
            PetGenre.Mystery => PetAccessory.Magnifier,
            PetGenre.Animation => PetAccessory.PropellerCap,
            PetGenre.Romance => PetAccessory.Bow,
            PetGenre.Family => PetAccessory.Bowtie,
            PetGenre.Documentary or PetGenre.Biography or PetGenre.History or PetGenre.News => PetAccessory.Specs,
            PetGenre.War => PetAccessory.Helmet,
            PetGenre.Western => PetAccessory.CowboyHat,
            PetGenre.Music or PetGenre.Musical => PetAccessory.Headphones,
            PetGenre.Short or PetGenre.RealityTV or PetGenre.TalkShow => PetAccessory.Popcorn,
            _ => PetAccessory.None,
        };

        public PetTone Tone => genre switch
        {
            PetGenre.Horror or PetGenre.Thriller or PetGenre.Crime or PetGenre.War or PetGenre.FilmNoir
                or PetGenre.Mystery => PetTone.Dusk,
            PetGenre.Comedy or PetGenre.Romance or PetGenre.Family or PetGenre.Animation or PetGenre.Music
                or PetGenre.Musical or PetGenre.Adventure or PetGenre.GameShow or PetGenre.RealityTV => PetTone.Sunny,
            _ => PetTone.Classic,
        };
    }

    extension(PetGenre)
    {
        public static PetGenre? FromRaw(string raw) => PetRaw.Parse<PetGenre>(raw);

        /// <summary>
        /// Swift's <c>Genre(name:)</c>: lower-cased, letters, marks and digits only, then looked up with
        /// aliases. "Sci-Fi", "science fiction" and "SciFi" are all <see cref="PetGenre.SciFi"/>.
        /// </summary>
        public static PetGenre? FromName(string name)
        {
            var key = PetGenreNames.Key(name);
            return PetGenreNames.Aliases.TryGetValue(key, out var genre) ? genre : null;
        }
    }
}

internal static class PetGenreNames
{
    public static readonly IReadOnlyDictionary<string, PetGenre> Aliases = MakeAliases();

    private static Dictionary<string, PetGenre> MakeAliases()
    {
        var map = new Dictionary<string, PetGenre>(StringComparer.Ordinal);
        foreach (var genre in Enum.GetValues<PetGenre>()) map[genre.ToRaw().ToLowerInvariant()] = genre;
        var extra = new Dictionary<string, PetGenre>
        {
            ["scifi"] = PetGenre.SciFi, ["sciencefiction"] = PetGenre.SciFi, ["sf"] = PetGenre.SciFi, ["scfi"] = PetGenre.SciFi,
            ["superhero"] = PetGenre.Action, ["martialarts"] = PetGenre.Action,
            ["suspense"] = PetGenre.Thriller, ["psychological"] = PetGenre.Thriller,
            ["noir"] = PetGenre.FilmNoir, ["neonoir"] = PetGenre.FilmNoir,
            ["animated"] = PetGenre.Animation, ["anime"] = PetGenre.Animation, ["cartoon"] = PetGenre.Animation,
            ["biopic"] = PetGenre.Biography, ["bio"] = PetGenre.Biography,
            ["historical"] = PetGenre.History, ["period"] = PetGenre.History,
            ["sports"] = PetGenre.Sport, ["kids"] = PetGenre.Family, ["children"] = PetGenre.Family, ["childrens"] = PetGenre.Family,
            ["doc"] = PetGenre.Documentary, ["docs"] = PetGenre.Documentary, ["docuseries"] = PetGenre.Documentary,
            ["documentaries"] = PetGenre.Documentary,
            ["reality"] = PetGenre.RealityTV, ["realitytv"] = PetGenre.RealityTV, ["talk"] = PetGenre.TalkShow,
            ["talkshow"] = PetGenre.TalkShow, ["gameshow"] = PetGenre.GameShow, ["romcom"] = PetGenre.Romance,
            ["romantic"] = PetGenre.Romance, ["comedies"] = PetGenre.Comedy, ["standup"] = PetGenre.Comedy,
            ["warpolitics"] = PetGenre.War, ["politics"] = PetGenre.News, ["soap"] = PetGenre.Drama, ["tvmovie"] = PetGenre.Drama,
            ["scififantasy"] = PetGenre.SciFi, ["actionadventure"] = PetGenre.Action,
        };
        foreach (var (key, genre) in extra) map[key] = genre;
        return map;
    }

    /// <summary>
    /// <c>name.lowercased()</c> keeping only Unicode letters, marks and numbers (Swift's
    /// <c>CharacterSet.alphanumerics</c>). Swift lower-cases with the full mapping, which differs from the
    /// simple one only for U+0130 (İ → i + combining dot).
    /// </summary>
    public static string Key(string name)
    {
        var key = new StringBuilder(name.Length);
        foreach (var rune in name.EnumerateRunes())
        {
            if (rune.Value == 0x130)
            {
                key.Append('i').Append('\u0307');
                continue;
            }
            var lower = Rune.ToLowerInvariant(rune);
            if (IsAlphanumeric(lower)) key.Append(lower.ToString());
        }
        return key.ToString();
    }

    private static bool IsAlphanumeric(Rune rune) => Rune.GetUnicodeCategory(rune) switch
    {
        UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
            or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
            or UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark
            or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber => true,
        _ => false,
    };
}

// MARK: - Growth (for progress UI)

/// <param name="ExperienceToNextStage">Experience still needed for the next stage (0 at Legend).</param>
/// <param name="Progress">0...1 progress through the current stage (1 at Legend).</param>
public readonly record struct PetGrowth(
    double Experience,
    int Level,
    PetStage Stage,
    PetStage? NextStage,
    double ExperienceToNextStage,
    double Progress);

// MARK: - Pet

/// <summary>
/// A small pixel-art creature that stands for someone's taste in films.
///
/// Species comes from the favourite genre, the accessory from the second, the colour tone from the third;
/// stage and level from how much they have watched; mood from how recently. Encodes to a short versioned
/// <see cref="Code"/> that friends can decode; JSON uses that same code string.
/// </summary>
[JsonConverter(typeof(PixelPetJsonConverter))]
public readonly record struct PixelPet
{
    public const int MaxLevel = 99;
    public const int NameCount = 1024;

    public PetSpecies Species { get; }
    public PetStage Stage { get; }
    public PetAccessory Accessory { get; }
    public PetTone Tone { get; }
    public PetMood Mood { get; }
    /// <summary>1...99.</summary>
    public int Level { get; }
    /// <summary>Index into the name syllable tables, 0..&lt;1024. See <see cref="Name"/>.</summary>
    public int NameIndex { get; }

    public PixelPet(
        PetSpecies species,
        PetStage stage,
        PetAccessory accessory = PetAccessory.None,
        PetTone tone = PetTone.Classic,
        PetMood mood = PetMood.Content,
        int level = 1,
        int nameIndex = 0)
    {
        Species = species;
        Stage = stage;
        Accessory = accessory;
        Tone = tone;
        Mood = mood;
        Level = Math.Min(Math.Max(level, 1), MaxLevel);
        NameIndex = Math.Min(Math.Max(nameIndex, 0), NameCount - 1);
    }

    public override string ToString() => Code;

    // MARK: Generator

    /// <summary>Experience points: hours plus 1.5 per finished title.</summary>
    public static double Experience(double hoursWatched, int titlesFinished)
    {
        var hours = double.IsFinite(hoursWatched) ? Math.Max(hoursWatched, 0) : 0;
        return hours + 1.5 * Math.Max(titlesFinished, 0);
    }

    public static int LevelForExperience(double experience)
    {
        var xp = double.IsFinite(experience) ? Math.Max(experience, 0) : 0;
        // Swift: min(1 + Int(xp.squareRoot()), maxLevel). Capped before converting so it can't overflow.
        return (int)Math.Min(1 + Math.Floor(Math.Min(Math.Sqrt(xp), 1e9)), MaxLevel);
    }

    public static PixelPet Make(PetTraits traits)
    {
        var ranked = RankedGenres(traits.Genres);
        var species = ranked.Count > 0 ? ranked[0].Species : PetSpecies.Slime;
        var accessory = ranked.Count > 1 ? ranked[1].Accessory : PetAccessory.None;
        PetTone tone;
        if (ranked.Count > 2)
        {
            tone = ranked[2].Tone;
        }
        else
        {
            var tones = Enum.GetValues<PetTone>();
            tone = tones[(int)((StableHash(traits.Seed) >> 20) % (ulong)tones.Length)];
        }
        var xp = Experience(traits.HoursWatched, traits.TitlesFinished);
        return new PixelPet(
            species: species,
            stage: PetStage.FromExperience(xp),
            accessory: accessory,
            tone: tone,
            mood: PetMood.FromDaysSinceLastWatch(traits.DaysSinceLastWatch),
            level: LevelForExperience(xp),
            nameIndex: NameIndexFor(traits.Seed, species));
    }

    private static readonly char[] GenreSeparators = ['&', '/', ',', '+'];

    /// <summary>
    /// Known genres with positive weight, merged by alias, heaviest first.
    /// Input order never matters; ties go to the more common genre.
    /// </summary>
    public static IReadOnlyList<PetGenre> RankedGenres(IEnumerable<GenreWeight> genres)
    {
        var parts = new List<(PetGenre Genre, double Weight)>();
        foreach (var entry in genres)
        {
            if (!(double.IsFinite(entry.Weight) && entry.Weight > 0)) continue;
            if (PetGenre.FromName(entry.Name) is { } genre)
            {
                parts.Add((genre, entry.Weight));
                continue;
            }
            // "Action & Adventure", "Sci-Fi & Fantasy", "Crime/Drama"...
            var pieces = entry.Name.Split(GenreSeparators, StringSplitOptions.RemoveEmptyEntries)
                .Select(n => PetGenre.FromName(n)).Where(g => g is not null).Select(g => g!.Value).ToList();
            foreach (var piece in pieces) parts.Add((piece, entry.Weight / pieces.Count));
        }
        // Sum in a canonical order so float rounding never depends on input order.
        parts.Sort((a, b) => a.Genre != b.Genre ? a.Genre.CompareTo(b.Genre) : a.Weight.CompareTo(b.Weight));
        var totals = new Dictionary<PetGenre, double>();
        foreach (var (genre, weight) in parts) totals[genre] = totals.GetValueOrDefault(genre) + weight;
        return totals.Keys
            .OrderByDescending(g => totals[g])
            .ThenBy(g => (int)g)
            .ToList();
    }

    /// <summary>FNV-1a, 64-bit, over the UTF-8 bytes. Stable across launches and platforms.</summary>
    public static ulong StableHash(string text)
    {
        var hash = 0xcbf2_9ce4_8422_2325UL;
        foreach (var b in Encoding.UTF8.GetBytes(text))
        {
            hash ^= b;
            hash = unchecked(hash * 0x0000_0100_0000_01b3UL);
        }
        return hash;
    }

    // MARK: Growth

    public static PetGrowth Growth(PetTraits traits)
    {
        var xp = Experience(traits.HoursWatched, traits.TitlesFinished);
        var stage = PetStage.FromExperience(xp);
        if (stage.Next is not { } next)
        {
            return new PetGrowth(xp, LevelForExperience(xp), stage, null, ExperienceToNextStage: 0, Progress: 1);
        }
        var span = next.MinimumExperience - stage.MinimumExperience;
        return new PetGrowth(
            Experience: xp,
            Level: LevelForExperience(xp),
            Stage: stage,
            NextStage: next,
            ExperienceToNextStage: Math.Max(next.MinimumExperience - xp, 0),
            Progress: Math.Min(Math.Max((xp - stage.MinimumExperience) / span, 0), 1));
    }

    // MARK: Labels, name, blurb

    public string SpeciesLabel => Species.Label;
    public string StageLabel => Stage.Label;
    public string MoodLabel => Mood.Label;
    public string AccessoryLabel => Accessory.Label;

    public static readonly IReadOnlyList<string> NameHeads =
    [
        "Mo", "Pi", "Bi", "Lu", "Ko", "Nu", "Ha", "Ze", "Ru", "Fi", "Zu", "Bo", "Mi", "Ka", "Yo", "Ne",
        "Ku", "Wa", "Yu", "Do", "Ki", "Ba", "Lo", "Gu", "Na", "Ri", "Po", "Ju", "Sa", "Te", "Ro", "Me",
    ];

    public static readonly IReadOnlyList<string> NameTails =
    [
        "chi", "xel", "mo", "bo", "ko", "ni", "pip", "lo", "mi", "by", "ra", "nu", "zu", "pa", "ki", "ru",
        "no", "ji", "pom", "bun", "sa", "mu", "do", "ri", "po", "tsu", "bi", "ppo", "na", "ku", "fi", "mel",
    ];

    public string Name => NameHeads[NameIndex / NameTails.Count % NameHeads.Count] + NameTails[NameIndex % NameTails.Count];

    public static int NameIndexFor(string seed, PetSpecies species) =>
        (int)(StableHash(seed + "|" + species.ToRaw()) % NameCount);

    /// <summary>One short line of personality.</summary>
    public string Blurb
    {
        get
        {
            IReadOnlyList<string> lines = Blurbs.TryGetValue(Species, out var known) ? known : ["Loves a good film night."];
            return lines[NameIndex % lines.Count];
        }
    }

    private static readonly IReadOnlyDictionary<PetSpecies, string[]> Blurbs = new Dictionary<PetSpecies, string[]>
    {
        [PetSpecies.Fox] = ["Raised on action, never looks back at explosions.",
                            "Does its own stunts. Mostly off the sofa.",
                            "Always ready for the sequel."],
        [PetSpecies.Turtle] = ["Slow walker, big explorer.",
                               "Packs snacks for every quest, even to the kitchen.",
                               "Has been to every map in the opening credits."],
        [PetSpecies.Cat] = ["Cries at every ending, denies it every time.",
                            "Sits in the dark, judging the cinematography.",
                            "Prefers a long, quiet character study."],
        [PetSpecies.Frog] = ["Laughs at the trailer, laughs harder at the bloopers.",
                             "Ribbit is short for one more episode.",
                             "Knows every catchphrase by heart."],
        [PetSpecies.Raccoon] = ["Solves the heist before the reveal.",
                                "Steals your popcorn. Calls it a setup.",
                                "Wears the mask, keeps the secrets."],
        [PetSpecies.Raven] = ["Raised on thrillers, sleeps with one eye open.",
                              "Saw the twist coming three scenes ago.",
                              "Trusts nobody in the first act."],
        [PetSpecies.Ghost] = ["Says it isn't scared. Watches through its fingers.",
                              "Haunts the sofa after midnight.",
                              "Boo is its review of every jump scare."],
        [PetSpecies.Robot] = ["Computes plot holes at 60 frames per second.",
                              "Dreams of electric sheep and director's cuts.",
                              "Beep boop: one more space opera."],
        [PetSpecies.Dragon] = ["Hoards Blu-rays instead of gold.",
                               "Reads every appendix of every saga.",
                               "Breathes fire at bad CGI."],
        [PetSpecies.Owl] = ["Has a theory about the ending. And a backup theory.",
                            "Stays up for the extended edition.",
                            "Pauses to read the footnotes."],
        [PetSpecies.Slime] = ["Still figuring out its favourite genre.",
                              "Absorbs every cartoon it can find.",
                              "Squishes happily through the credits."],
        [PetSpecies.Bunny] = ["Hops straight to the happy ending.",
                              "Keeps a list of perfect first-date films.",
                              "Believes in love at first scene."],
        [PetSpecies.Puppy] = ["Wags at the opening credits.",
                              "Brings the remote back every single time.",
                              "Cheers for the underdog. Always."],
        [PetSpecies.Songbird] = ["Hums the score for days after.",
                                 "Knows every soundtrack by heart.",
                                 "Sings along. Loudly."],
        [PetSpecies.Hedgehog] = ["Small, spiky, brave through any battle scene.",
                                 "Never leaves a film unfinished.",
                                 "Salutes the end credits."],
    };

    public string AccessibilityDescription
    {
        get
        {
            var text = $"{Name}, a {MoodLabel.ToLowerInvariant()} {StageLabel.ToLowerInvariant()} {SpeciesLabel.ToLowerInvariant()}, level {Level.ToString(CultureInfo.InvariantCulture)}";
            if (Accessory != PetAccessory.None) text += $", with {Accessory.Label.ToLowerInvariant()}";
            return text;
        }
    }

    // MARK: Code

    public const string CodePrefix = "p1-";
    private const string CodeAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";

    /// <summary>Compact, URL-safe, versioned: <c>p1-</c> + 10 base-32 characters (13 total).</summary>
    public string Code
    {
        get
        {
            int[] fields =
            [
                (int)Species, (int)Stage, (int)Accessory, (int)Tone, (int)Mood,
                Level / 32, Level % 32, NameIndex / 32, NameIndex % 32,
            ];
            var body = new string(fields.Select(f => CodeAlphabet[f]).ToArray());
            return CodePrefix + body + CodeAlphabet[Checksum(body)];
        }
    }

    /// <summary>Swift's <c>PixelPet(code:)</c>: the pet, or null for anything that isn't a valid code.</summary>
    public static PixelPet? FromCode(string? code)
    {
        if (code is null) return null;
        var text = code.Trim(CodeWhitespace).ToLowerInvariant();
        if (!text.StartsWith(CodePrefix, StringComparison.Ordinal)) return null;
        var chars = text[CodePrefix.Length..];
        if (chars.Length != 10) return null;
        var values = new int[10];
        for (var i = 0; i < chars.Length; i++)
        {
            var value = CodeAlphabet.IndexOf(chars[i]);
            if (value < 0) return null;
            values[i] = value;
        }
        var body = chars[..9];
        if (values[9] != Checksum(body)) return null;
        var level = values[5] * 32 + values[6];
        var nameIndex = values[7] * 32 + values[8];
        if (values[0] >= Enum.GetValues<PetSpecies>().Length || values[1] >= Enum.GetValues<PetStage>().Length
            || values[2] >= Enum.GetValues<PetAccessory>().Length || values[3] >= Enum.GetValues<PetTone>().Length
            || values[4] >= Enum.GetValues<PetMood>().Length || level < 1 || level > MaxLevel || nameIndex >= NameCount)
        {
            return null;
        }
        return new PixelPet(
            (PetSpecies)values[0], (PetStage)values[1], (PetAccessory)values[2], (PetTone)values[3], (PetMood)values[4],
            level, nameIndex);
    }

    public static bool TryParse(string? code, out PixelPet pet)
    {
        var parsed = FromCode(code);
        pet = parsed.GetValueOrDefault();
        return parsed is not null;
    }

    /// <summary>
    /// Swift's <c>CharacterSet.whitespacesAndNewlines</c>: .NET's white space plus U+200B ZERO WIDTH SPACE,
    /// which Foundation still counts (checked against Foundation for every code point).
    /// </summary>
    private static readonly char[] CodeWhitespace =
    [
        '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u0085', '\u00A0', '\u1680',
        '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009',
        '\u200A', '\u200B', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000',
    ];

    private static int Checksum(string body) => (int)(StableHash(CodePrefix + body) % (ulong)CodeAlphabet.Length);

    // MARK: Animation frames

    /// <summary>A still pose that still tells the mood (used when not animated, and for Reduce Motion).</summary>
    public PetFrame RestingFrame
    {
        get
        {
            var frame = new PetFrame { Mouth = BaseMouth };
            switch (Mood)
            {
                case PetMood.Happy:
                    frame.Effect = PetEffect.Heart; frame.EffectStep = 3;
                    break;
                case PetMood.Content:
                    break;
                case PetMood.Bored:
                    frame.Eyes = PetEyes.Heavy; frame.Effect = PetEffect.Dots; frame.EffectStep = 3;
                    break;
                case PetMood.Sleepy:
                    frame.Eyes = PetEyes.Closed; frame.Effect = PetEffect.Zzz; frame.EffectStep = 5;
                    break;
            }
            if (Stage == PetStage.Legend) frame.Sparkle = 2;
            return frame;
        }
    }

    private PetMouth BaseMouth => Mood switch
    {
        PetMood.Happy => PetMouth.Grin,
        PetMood.Content => PetMouth.Smile,
        PetMood.Bored => PetMouth.Flat,
        _ => PetMouth.Small,
    };

    private static readonly int[] HopLift = [1, 2, 3, 2, 1];

    /// <summary>
    /// The frame at <paramref name="time"/> (seconds, any epoch; the Mac uses seconds since 2001-01-01, see
    /// <see cref="PetCanvas.Now"/>). Each pet runs slightly out of phase with others so a row of avatars
    /// doesn't blink in unison.
    /// </summary>
    public PetFrame FrameAt(double time)
    {
        var t = time + NameIndex * 0.37;
        double Phase(double period)
        {
            var r = t % period;
            return r < 0 ? r + period : r;
        }
        var frame = new PetFrame { Mouth = BaseMouth };
        var blinkPeriod = 3.3 + NameIndex % 5 * 0.35;
        var blinking = Phase(blinkPeriod) < 0.15;
        switch (Mood)
        {
            case PetMood.Happy:
            {
                var u = Phase(5.2);
                if (u < 0.5)
                {
                    frame.Lift = HopLift[Math.Min((int)(u / 0.1), 4)];
                    frame.Eyes = PetEyes.Happy;
                }
                else
                {
                    frame.Lift = Phase(0.8) < 0.4 ? 1 : 0;
                    frame.Eyes = u < 0.9 ? PetEyes.Happy : (blinking ? PetEyes.Closed : PetEyes.Open);
                }
                if (u >= 0.3 && u < 2.1)
                {
                    frame.Effect = PetEffect.Heart;
                    frame.EffectStep = (int)((u - 0.3) / 0.3);
                }
                break;
            }
            case PetMood.Content:
                frame.Lift = Phase(1.6) < 0.8 ? 0 : 1;
                frame.Eyes = blinking ? PetEyes.Closed : PetEyes.Open;
                break;
            case PetMood.Bored:
            {
                frame.Lift = Phase(2.4) < 1.2 ? 0 : 1;
                frame.Eyes = blinking ? PetEyes.Closed : PetEyes.Heavy;
                var u = Phase(4.5);
                if (u >= 1.0)
                {
                    frame.Effect = PetEffect.Dots;
                    frame.EffectStep = Math.Min((int)((u - 1.0) / 0.5) + 1, 3);
                }
                break;
            }
            case PetMood.Sleepy:
                frame.Lift = Phase(3.0) < 1.5 ? 0 : 1;
                frame.Eyes = PetEyes.Closed;
                frame.Effect = PetEffect.Zzz;
                frame.EffectStep = (int)(Phase(2.8) / 0.4);
                break;
        }
        // Capped at 5: a phase just under 1.8 can round to 6.0 after dividing (name 335 at 0.25 s does), and
        // the Mac's renderer then indexes past its 6-entry twinkle table and traps. Same frame otherwise.
        if (Stage == PetStage.Legend) frame.Sparkle = Math.Min((int)(Phase(1.8) / 0.3), 5);
        return frame;
    }

    // MARK: Bitmap

    /// <summary>Renders <paramref name="frame"/> (the resting frame by default) to a 24×24 bitmap.</summary>
    public PetBitmap Bitmap(PetFrame? frame = null) => new PetRenderer(this, frame ?? RestingFrame).Render();

    // MARK: Framing

    /// <summary>
    /// Bounding box of the pet itself (body, accessory, crown) on the canvas, plus one row of headroom for
    /// the idle bob. Floating effects (z's, hearts) are not included.
    /// </summary>
    public PetArt.Rect ContentBounds
    {
        get
        {
            var still = RestingFrame;
            still.Effect = PetEffect.None;
            still.Sparkle = null;
            var bitmap = Bitmap(still);
            const int n = PetBitmap.Size;
            int minX = n, minY = n, maxX = -1, maxY = -1;
            for (var y = 0; y < n; y++)
            {
                for (var x = 0; x < n; x++)
                {
                    if (bitmap[x, y] == 0) continue;
                    minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y);
                }
            }
            if (maxX < 0) return new PetArt.Rect(0, 0, n, n);
            minY = Math.Max(minY - 1, 0);
            return new PetArt.Rect(minX, minY, maxX - minX + 1, maxY - minY + 1);
        }
    }

    /// <summary>
    /// The square to show when filling <paramref name="devicePixels"/> × <paramref name="devicePixels"/>: the
    /// whole pet, unless that leaves under 2 device pixels per cell and a head-and-shoulders bust (≥ 16 cells)
    /// does better.
    /// </summary>
    public static PetCrop TightCrop(PetArt.Rect bounds, int devicePixels)
    {
        const int n = PetBitmap.Size;
        var whole = Math.Min(Math.Max(Math.Max(bounds.W, bounds.H), 12), n);
        var bust = Math.Min(whole, 16);
        var pixels = Math.Max(devicePixels, 1);
        var side = whole;
        // Only crop into a bust when the whole pet would get less than 2 device pixels per cell.
        if (pixels / whole < 2 && Math.Max(1, pixels / bust) > Math.Max(1, pixels / whole))
        {
            side = Math.Min(whole, Math.Max(pixels / Math.Max(1, pixels / bust), bust));
        }
        var x = side >= bounds.W ? bounds.X - (side - bounds.W) / 2 : PetArt.CenterX - (side - 1) / 2;
        var y = side >= bounds.H ? bounds.Y + bounds.H - side : bounds.Y;
        x = Math.Min(Math.Max(x, 0), n - side);
        y = Math.Min(Math.Max(y, 0), n - side);
        return new PetCrop(x, y, side);
    }
}

/// <summary>Reads and writes a pet as its code string, like the Swift <c>Codable</c> conformance.</summary>
public sealed class PixelPetJsonConverter : JsonConverter<PixelPet>
{
    public override PixelPet Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String) throw new JsonException("Not a pet code");
        var text = reader.GetString();
        return PixelPet.FromCode(text) ?? throw new JsonException($"Not a pet code: {text}");
    }

    public override void Write(Utf8JsonWriter writer, PixelPet value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.Code);
}

// MARK: - Frame

public enum PetEyes { Open, Closed, Happy, Heavy }

public enum PetMouth { Smile, Grin, Flat, Small }

public enum PetEffect { None, Zzz, Heart, Dots }

/// <summary>
/// One drawable moment: what the pet is doing at a given time (Swift's <c>PixelPet.Frame</c>).
/// <c>default</c> is Swift's <c>Frame()</c>: no lift, open eyes, smile, no effect.
/// </summary>
public record struct PetFrame
{
    public int Lift { get; set; }
    public PetEyes Eyes { get; set; }
    public PetMouth Mouth { get; set; }
    public PetEffect Effect { get; set; }
    public int EffectStep { get; set; }
    /// <summary>Legend twinkle phase 0..&lt;6, null for other stages.</summary>
    public int? Sparkle { get; set; }
}

/// <summary>Square region of the 24×24 canvas to show.</summary>
public readonly record struct PetCrop(int X, int Y, int Side)
{
    public static readonly PetCrop Canvas = new(0, 0, PetBitmap.Size);
}

// MARK: - Bitmap

/// <summary>A rendered 24×24 frame. 0 is transparent, anything else is 0xFFRRGGBB (always opaque).</summary>
public sealed class PetBitmap : IEquatable<PetBitmap>
{
    public const int Size = 24;

    /// <summary>Row-major, <see cref="Size"/> × <see cref="Size"/>.</summary>
    public uint[] Pixels { get; } = new uint[Size * Size];

    public uint this[int x, int y]
    {
        get => x is >= 0 and < Size && y is >= 0 and < Size ? Pixels[y * Size + x] : 0;
        set
        {
            if (x is < 0 or >= Size || y is < 0 or >= Size) return;
            Pixels[y * Size + x] = value;
        }
    }

    /// <summary>
    /// The crop (the whole canvas by default) as premultiplied BGRA8, one byte quad per pet pixel, rows top
    /// down, stride <c>side × 4</c>. Scale it up with nearest-neighbour only.
    /// </summary>
    public byte[] ToBgra(PetCrop? crop = null)
    {
        var c = crop ?? PetCrop.Canvas;
        var bytes = new byte[c.Side * c.Side * 4];
        for (var row = 0; row < c.Side; row++)
        {
            for (var col = 0; col < c.Side; col++)
            {
                PetCanvas.WriteBgra(bytes, (row * c.Side + col) * 4, this[c.X + col, c.Y + row]);
            }
        }
        return bytes;
    }

    public bool Equals(PetBitmap? other) => other is not null && Pixels.AsSpan().SequenceEqual(other.Pixels);

    public override bool Equals(object? obj) => Equals(obj as PetBitmap);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        hash.AddBytes(System.Runtime.InteropServices.MemoryMarshal.AsBytes(Pixels.AsSpan()));
        return hash.ToHashCode();
    }
}
