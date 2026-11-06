using System.Text;

namespace Cineon.Core.Profile;

/// <summary>
/// Sprite and overlay data. Grids use one character per pixel:
/// <code>
///     .  transparent      o  outline         e  eye ink (palette)
///     b  base             s  shade           l  light
///     a  accent (belly, muzzle)              c  detail (ears, cheeks, beak)
///     d  dark detail      w  white           t  tongue
///     E  eye (drawn by mood)                 M  mouth anchor (drawn by mood)
/// </code>
/// Overlays may also use the shared accessory colours (r R y Y g G p P u U n N h H v V m j q k K).
/// Port of <c>PetArt</c> in <c>Cineon/Profile/PixelPet.swift</c>; the grids are copied verbatim.
/// </summary>
public static partial class PetArt
{
    public const int CenterX = 11;
    public const int GroundY = 23;

    /// <summary>The key byte of an art character (its ASCII value; '.' for anything else).</summary>
    public static byte K(char c) => c < 128 ? (byte)c : (byte)46;

    public readonly record struct Point(int X, int Y);

    public readonly record struct Rect(int X, int Y, int W, int H);

    public sealed class Sprite
    {
        public required int Width { get; init; }
        public required int Height { get; init; }
        public required byte[] Keys { get; init; }
        /// <summary>Centre of the top of the skull (hats sit here).</summary>
        public required Point Head { get; init; }
        /// <summary>Row of the chin/neck line (scarves, bow ties).</summary>
        public required int Neck { get; init; }
        /// <summary>Bottom-left of held props.</summary>
        public required Point Hand { get; init; }
        public required IReadOnlyList<Rect> Eyes { get; init; }
        public required Point? Mouth { get; init; }
        public required int HeadHalfWidth { get; init; }
        /// <summary>False when the source rows had different lengths (an authoring mistake).</summary>
        public required bool IsRectangular { get; init; }

        public byte Key(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return 46;
            return Keys[y * Width + x];
        }
    }

    public sealed class Overlay
    {
        public int Width { get; }
        public int Height { get; }
        public byte[] Keys { get; }
        /// <summary>Rows below the anchor where the bottom row lands.</summary>
        public int Dy { get; }
        public bool IsRectangular { get; }

        public Overlay(string text, int dy = 0)
        {
            var rows = Rows(text);
            var width = rows.Count == 0 ? 0 : rows.Max(r => r.Length);
            Width = width;
            Height = rows.Count;
            var keys = new byte[width * rows.Count];
            Array.Fill(keys, (byte)46);
            for (var y = 0; y < rows.Count; y++) rows[y].CopyTo(keys, y * width);
            Keys = keys;
            Dy = dy;
            IsRectangular = rows.Select(r => r.Length).Distinct().Count() <= 1;
        }

        public byte Key(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return 46;
            return Keys[y * Width + x];
        }
    }

    internal readonly record struct Patch(int X, int Y, string Text, bool Under = true);
    // Under: only fills transparent cells (tails behind bodies).

    internal sealed class SpriteSet(Sprite baby, Sprite teen, Sprite adult)
    {
        public Sprite Baby { get; } = baby;
        public Sprite Teen { get; } = teen;
        public Sprite Adult { get; } = adult;
    }

    /// <summary>Non-empty rows, each trimmed, as key bytes.</summary>
    internal static List<byte[]> Rows(string text)
    {
        var rows = new List<byte[]>();
        foreach (var line in text.Split('\n'))
        {
            // Swift trims spaces and tabs; '\r' only shows up on a CRLF checkout, and goes too.
            var trimmed = line.Trim();
            if (trimmed.Length > 0) rows.Add(Encoding.UTF8.GetBytes(trimmed));
        }
        return rows;
    }

    /// <summary>Builds a symmetric sprite from its left half (including the centre column).</summary>
    internal static Sprite Sym(string half, int head, int neck, (int X, int Y) hand, Patch[]? patches = null)
    {
        patches ??= [];
        var halves = Rows(half);
        var full = halves.Select(row => row.Concat(row.Take(row.Length - 1).Reverse()).ToArray()).ToList();
        var rectangular = halves.Select(r => r.Length).Distinct().Count() == 1
            && patches.All(p => Rows(p.Text).Select(r => r.Length).Distinct().Count() == 1);
        return Build(full, headX: (halves.Count > 0 ? halves[0].Length : 1) - 1, headY: head, neck: neck, hand: hand,
            patches: patches, rectangular: rectangular);
    }

    internal static Sprite Build(
        List<byte[]> grid, int headX, int headY, int neck, (int X, int Y) hand, Patch[] patches, bool rectangular)
    {
        var width = grid.Count == 0 ? 0 : grid.Max(r => r.Length);
        var height = grid.Count;
        foreach (var patch in patches)
        {
            var pr = Rows(patch.Text);
            width = Math.Max(width, patch.X + (pr.Count == 0 ? 0 : pr.Max(r => r.Length)));
            height = Math.Max(height, patch.Y + pr.Count);
        }
        var keys = new byte[width * height];
        Array.Fill(keys, (byte)46);
        for (var y = 0; y < grid.Count; y++)
        {
            for (var x = 0; x < grid[y].Length; x++) keys[y * width + x] = grid[y][x];
        }
        foreach (var patch in patches)
        {
            var rows = Rows(patch.Text);
            for (var dy = 0; dy < rows.Count; dy++)
            {
                for (var dx = 0; dx < rows[dy].Length; dx++)
                {
                    var key = rows[dy][dx];
                    if (key == 46) continue;
                    var i = (patch.Y + dy) * width + patch.X + dx;
                    if (!patch.Under || keys[i] == 46) keys[i] = key;
                }
            }
        }
        // Mouth anchor: remember it, then paint it like its left neighbour.
        Point? mouth = null;
        for (var i = 0; i < keys.Length; i++)
        {
            if (keys[i] != K('M')) continue;
            mouth = new Point(i % width, i / width);
            keys[i] = i > 0 ? keys[i - 1] : K('b');
        }
        // Eyes: connected runs of E.
        var eyes = new List<Rect>();
        var seen = new HashSet<int>();
        for (var i = 0; i < keys.Length; i++)
        {
            if (keys[i] != K('E') || seen.Contains(i)) continue;
            var stack = new List<int> { i };
            int minX = width, minY = height, maxX = 0, maxY = 0;
            seen.Add(i);
            while (stack.Count > 0)
            {
                var j = stack[^1];
                stack.RemoveAt(stack.Count - 1);
                int x = j % width, y = j / width;
                minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y);
                foreach (var (nx, ny) in new[] { (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1) })
                {
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    var n = ny * width + nx;
                    if (keys[n] == K('E') && seen.Add(n)) stack.Add(n);
                }
            }
            eyes.Add(new Rect(minX, minY, maxX - minX + 1, maxY - minY + 1));
        }
        eyes.Sort((a, b) => a.X.CompareTo(b.X));
        // Half width of the head: distance from centre to the widest outline at eye level.
        var half = 4;
        if (eyes.Count > 0)
        {
            var eyeRow = eyes[0].Y;
            var x = headX;
            while (x < width - 1
                   && !(keys[eyeRow * width + x] == K('o') && (x + 1 >= width || keys[eyeRow * width + x + 1] == 46)))
            {
                x += 1;
            }
            half = x - headX;
        }
        return new Sprite
        {
            Width = width, Height = height, Keys = keys, Head = new Point(headX, headY), Neck = neck,
            Hand = new Point(hand.X, hand.Y), Eyes = eyes, Mouth = mouth, HeadHalfWidth = half,
            IsRectangular = rectangular,
        };
    }

    // MARK: Lookup

    /// <summary>Built on first use, after every sprite set above exists.</summary>
    private static class Tables
    {
        public static readonly Sprite[][] Sprites = Enum.GetValues<PetSpecies>().Select(species =>
        {
            var set = Art(species);
            return new[] { set.Baby, set.Teen, set.Adult };
        }).ToArray();

        public static readonly uint[][][] Palettes = Enum.GetValues<PetSpecies>().Select(species =>
            Enum.GetValues<PetTone>().Select(tone => MakePalette(PaletteSpec(species, tone))).ToArray()).ToArray();
    }

    public static Sprite SpriteFor(PetSpecies species, PetStage stage)
    {
        var i = stage switch
        {
            PetStage.Baby => 0,
            PetStage.Teen => 1,
            _ => 2,
        };
        return Tables.Sprites[(int)species][i];
    }

    /// <summary>128 entries indexed by key byte: 0xFFRRGGBB, or 0 where the key has no colour.</summary>
    public static uint[] Palette(PetSpecies species, PetTone tone) => Tables.Palettes[(int)species][(int)tone];

    /// <summary>Keys every palette must define (the sprite keys plus <c>e</c>).</summary>
    public static readonly IReadOnlySet<char> SpriteKeys =
        new HashSet<char> { '.', 'o', 'b', 's', 'l', 'a', 'c', 'd', 'w', 't', 'e', 'i', 'E', 'M' };

    /// <summary>Every overlay, for checks.</summary>
    public static IReadOnlyList<(string Name, Overlay Overlay)> AllOverlays
    {
        get
        {
            var list = new List<(string, Overlay)>
            {
                ("crown", Crown), ("horn", Horn), ("bow", Bow), ("bowtie", Bowtie), ("popcorn", Popcorn),
                ("magnifier", Magnifier), ("zSmall", ZSmall), ("zBig", ZBig), ("heart", Heart),
                ("heartSmall", HeartSmall), ("bubble", Bubble),
            };
            foreach (var (accessory, overlay) in Hats.OrderBy(p => p.Key.ToRaw(), StringComparer.Ordinal))
            {
                list.Add((accessory.ToRaw(), overlay));
            }
            return list;
        }
    }

    /// <summary>Keys of the shared accessory colours.</summary>
    public static IReadOnlySet<char> SharedKeys =>
        Shared.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(p => p[0]).ToHashSet();

    public const string Shared = "w=fff8ef t=ff6b8a r=e8473f R=a8292f y=ffd23f Y=e09b1a g=c9cfdd G=6b7187 p=ff7eb6 P=d2468a u=4f8cff U=2f4fa8 n=8a5a3c N=5e3a26 h=e2c58a H=b0905a v=7b5cff V=4f36c4 m=6fae4f j=3f7a37 q=4fe0e8 k=1d1b26 K=4a4a5e";

    public static uint[] MakePalette(string spec)
    {
        var table = new uint[128];
        foreach (var pair in (Shared + " " + spec).Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 2 || parts[0][0] >= 128) continue;
            if (!uint.TryParse(parts[1], System.Globalization.NumberStyles.AllowHexSpecifier, null, out var rgb)) continue;
            table[parts[0][0]] = 0xFF00_0000 | rgb;
        }
        if (table[K('e')] == 0) table[K('e')] = table[K('o')];
        if (table[K('i')] == 0) table[K('i')] = table[K('o')];
        return table;
    }

    // MARK: Overlays

    public static readonly Overlay Crown = new("""
        .o.o.o.
        oyoyoyo
        oyyyyyo
        oyryuyo
        ooooooo
        """, dy: 1);

    public static readonly IReadOnlyDictionary<PetAccessory, Overlay> Hats = new Dictionary<PetAccessory, Overlay>
    {
        [PetAccessory.PartyHat] = new Overlay("""
            ...y...
            ..oyo..
            ..oro..
            .orrro.
            .oyyyo.
            orrrrro
            ooooooo
            """, dy: 1),
        [PetAccessory.WizardHat] = new Overlay("""
            ....o....
            ...ovo...
            ...ovo...
            ..ovvvo..
            ..ovyvo..
            .ovvvvvo.
            ooooooooo
            oVVVVVVVo
            ooooooooo
            """, dy: 2),
        [PetAccessory.Fedora] = new Overlay("""
            ..ooooo..
            .onnnnno.
            .oNNNNNo.
            onnnnnnno
            ooooooooo
            """, dy: 1),
        [PetAccessory.CowboyHat] = new Overlay("""
            ...ooooo...
            ..onnnnno..
            o.oNNNNNo.o
            onooooooono
            .onnnnnnno.
            ..ooooooo..
            """, dy: 1),
        [PetAccessory.ExplorerHat] = new Overlay("""
            ...ooo...
            ..ohhho..
            .ohhhhho.
            .oHHHHHo.
            ohhhhhhho
            ooooooooo
            """, dy: 1),
        [PetAccessory.Helmet] = new Overlay("""
            ..ooooo..
            .ommmmmo.
            ommjmmmmo
            ommmmmjmo
            ojjjjjjjo
            ooooooooo
            """, dy: 1),
        [PetAccessory.PropellerCap] = new Overlay("""
            .rrrouuu.
            ....o....
            ..ooooo..
            .oyrrruo.
            oyyrrruuo
            ooooooooo
            """, dy: 1),
    };

    /// Left horn; its bottom-right pixel sits on the skull.
    public static readonly Overlay Horn = new("""
        o...
        oro.
        orRo
        .oro
        """);

    public static readonly Overlay Bow = new("""
        oo...oo
        oppopPo
        opPPPPo
        oppopPo
        oo...oo
        """, dy: 2);

    public static readonly Overlay Bowtie = new("""
        oo...oo
        orroRRo
        orRRRRo
        orroRRo
        oo...oo
        """, dy: 1);

    public static readonly Overlay Popcorn = new("""
        .wyw.
        wywyw
        orwro
        orwro
        orwro
        .ooo.
        """);

    public static readonly Overlay Magnifier = new("""
        .ooo..
        owqqo.
        oqqqo.
        .ooon.
        ....nn
        """);

    public static readonly Overlay ZSmall = new("""
        uuu
        .u.
        uuu
        """);

    public static readonly Overlay ZBig = new("""
        uuuu
        ..u.
        .u..
        uuuu
        """);

    public static readonly Overlay Heart = new("""
        pp.pp
        ppppp
        .ppp.
        ..p..
        """);

    public static readonly Overlay HeartSmall = new("""
        p.p
        .p.
        """);

    public static readonly Overlay Bubble = new("""
        .ooooooo.
        owwwwwwwo
        owwwwwwwo
        owwwwwwwo
        .ooooooo.
        .o.......
        o........
        """);
}
