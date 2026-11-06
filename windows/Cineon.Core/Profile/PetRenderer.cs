namespace Cineon.Core.Profile;

/// <summary>Draws one pose of a pet into a 24×24 <see cref="PetBitmap"/>. Port of the Swift <c>PetRenderer</c>.</summary>
internal sealed class PetRenderer
{
    private readonly PixelPet pet;
    private readonly PetFrame frame;
    private readonly PetArt.Sprite sprite;
    private readonly uint[] colors;
    private readonly int ox;
    private readonly int oy;
    private readonly PetBitmap output = new();

    public PetRenderer(PixelPet pet, PetFrame frame)
    {
        this.pet = pet;
        this.frame = frame;
        sprite = PetArt.SpriteFor(pet.Species, pet.Stage);
        colors = PetArt.Palette(pet.Species, pet.Tone);
        ox = PetArt.CenterX - sprite.Head.X;
        oy = PetArt.GroundY - (sprite.Height - 1) - frame.Lift;
    }

    private uint Color(byte key) => colors[key & 0x7F];

    private uint Color(char key) => Color(PetArt.K(key));

    private uint Outline => Color('o');

    private void Put(int x, int y, uint c)
    {
        if (c != 0) output[x, y] = c;
    }

    /// <summary>Sprite-space put.</summary>
    private void SPut(int x, int y, uint c) => Put(ox + x, oy + y, c);

    public PetBitmap Render()
    {
        DrawBody();
        DrawEyes();
        DrawMouth();
        DrawAccessory();
        if (pet.Stage == PetStage.Legend) Stamp(PetArt.Crown, sprite.Head, dy: PetArt.Crown.Dy);
        DrawEffect();
        DrawSparkles();
        return output;
    }

    private void DrawBody()
    {
        for (var y = 0; y < sprite.Height; y++)
        {
            for (var x = 0; x < sprite.Width; x++)
            {
                var key = sprite.Key(x, y);
                if (key != PetArt.K('.')) SPut(x, y, Color(key));
            }
        }
    }

    /// <summary>Colour just above an eye: what an eyelid would be.</summary>
    private uint LidColor(PetArt.Rect eye)
    {
        foreach (var (x, y) in new[] { (eye.X, eye.Y - 1), (eye.X - 1, eye.Y), (eye.X + eye.W, eye.Y) })
        {
            var key = sprite.Key(x, y);
            if (key != PetArt.K('.') && key != PetArt.K('o') && key != PetArt.K('E')) return Color(key);
        }
        return Color('b');
    }

    private void DrawEyes()
    {
        var eye = Color('e');
        var shine = Color('w');
        var heavyLid = Color('s');
        for (var index = 0; index < sprite.Eyes.Count; index++)
        {
            var rect = sprite.Eyes[index];
            var lid = LidColor(rect);
            var isLeft = index == 0;
            for (var dy = 0; dy < rect.H; dy++)
            {
                for (var dx = 0; dx < rect.W; dx++)
                {
                    var last = dy == rect.H - 1;
                    var c = eye;
                    switch (frame.Eyes)
                    {
                        case PetEyes.Open:
                            if (dx == 0 && dy == 0 && rect.W > 1 && rect.H > 1) c = shine;
                            break;
                        case PetEyes.Heavy:
                            if (dy == 0 && rect.H > 1) c = heavyLid;
                            break;
                        case PetEyes.Closed:
                            if (!last) c = lid;
                            break;
                        case PetEyes.Happy:
                            // ◠ ◠ : top row plus the outer corner below it.
                            var outer = isLeft ? dx == 0 : dx == rect.W - 1;
                            if (dy > 0 && !(dy == 1 && outer)) c = lid;
                            break;
                    }
                    SPut(rect.X + dx, rect.Y + dy, c);
                }
            }
        }
    }

    private void DrawMouth()
    {
        if (sprite.Mouth is not { } m) return;
        var ink = Color('i');
        var tongue = Color('t');
        (int, int, uint)[] offsets = frame.Mouth switch
        {
            PetMouth.Smile => [(-1, 0, ink), (1, 0, ink), (0, 1, ink)],
            PetMouth.Grin => [(-1, 0, ink), (0, 0, ink), (1, 0, ink), (0, 1, tongue)],
            PetMouth.Flat => [(-1, 0, ink), (0, 0, ink), (1, 0, ink)],
            _ => [(0, 0, ink)],
        };
        foreach (var (dx, dy, c) in offsets) SPut(m.X + dx, m.Y + dy, c);
    }

    /// <summary>Stamps an overlay so its bottom row lands <paramref name="dy"/> rows below <paramref name="anchor"/>, centred on it.</summary>
    private void Stamp(PetArt.Overlay overlay, PetArt.Point anchor, int dy, int dx = 0)
    {
        var left = anchor.X + dx - overlay.Width / 2;
        var top = anchor.Y + dy - (overlay.Height - 1);
        for (var y = 0; y < overlay.Height; y++)
        {
            for (var x = 0; x < overlay.Width; x++)
            {
                var key = overlay.Key(x, y);
                if (key != PetArt.K('.')) SPut(left + x, top + y, Color(key));
            }
        }
    }

    /// <summary>First outline cell left and right of <paramref name="x"/> on <paramref name="row"/>.</summary>
    private (int Left, int Right) Silhouette(int row, int x)
    {
        var o = PetArt.K('o');
        int l = x, r = x;
        if (sprite.Key(x, row) == o) return (x, x);
        while (l > 0 && sprite.Key(l, row) != o) l -= 1;
        while (r < sprite.Width - 1 && sprite.Key(r, row) != o) r += 1;
        return (l, r);
    }

    private void DrawAccessory()
    {
        var accessory = pet.Accessory;
        if (pet.Stage == PetStage.Legend && accessory.IsHat) return;
        var ink = Outline;
        switch (accessory)
        {
            case PetAccessory.None:
                return;
            case PetAccessory.Specs or PetAccessory.Shades or PetAccessory.Glasses3D:
                DrawGlasses(accessory);
                break;
            case PetAccessory.Headband:
            {
                if (sprite.Eyes.Count == 0) return;
                var top = sprite.Eyes.Min(e => e.Y);
                var row = top - 2;
                var (l, r) = Silhouette(row, sprite.Head.X);
                uint red = Color('r'), dark = Color('R');
                for (var x = l; x <= r; x++) SPut(x, row, x == l || x == r ? dark : red);
                SPut(r + 1, row, red); SPut(r + 2, row + 1, red); SPut(r + 1, row + 1, dark);
                SPut(r + 2, row + 2, dark);
                break;
            }
            case PetAccessory.Headphones:
            {
                if (sprite.Eyes.Count == 0) return;
                var top = sprite.Eyes.Min(e => e.Y);
                var (l, r) = Silhouette(top, sprite.Head.X);
                uint band = Color('K'), cup = Color('r');
                var crown = sprite.Head.Y - 1;
                for (var y = crown + 1; y <= top - 1; y++) { SPut(l, y, band); SPut(r, y, band); }
                for (var x = l + 1; x <= r - 1; x++) SPut(x, crown, band);
                foreach (var side in new[] { l - 1, r })
                {
                    for (var y = top - 1; y <= top + 2; y++)
                    {
                        for (var x = side; x <= side + 1; x++)
                        {
                            var edge = y == top - 1 || y == top + 2 || (x == side && side < l) || (x == side + 1 && side == r);
                            SPut(x, y, edge ? ink : cup);
                        }
                    }
                }
                break;
            }
            case PetAccessory.Scarf:
            {
                var row = sprite.Neck;
                var (l, r) = Silhouette(row, sprite.Head.X);
                uint red = Color('r'), dark = Color('R');
                for (var x = l; x <= r; x++)
                {
                    SPut(x, row, x == l || x == r ? ink : red);
                    SPut(x, row + 1, x == l || x == r ? ink : dark);
                }
                // Hanging end.
                var tx = r - 3;
                for (var y = row + 2; y <= row + 4; y++)
                {
                    SPut(tx, y, red); SPut(tx + 1, y, dark); SPut(tx - 1, y, ink); SPut(tx + 2, y, ink);
                }
                SPut(tx, row + 5, ink); SPut(tx + 1, row + 5, ink);
                break;
            }
            case PetAccessory.Bowtie:
                Stamp(PetArt.Bowtie, new PetArt.Point(sprite.Head.X, sprite.Neck), dy: 1);
                break;
            case PetAccessory.Popcorn:
                StampLeft(PetArt.Popcorn, sprite.Hand);
                break;
            case PetAccessory.Magnifier:
                StampLeft(PetArt.Magnifier, sprite.Hand);
                break;
            case PetAccessory.Bow:
                Stamp(PetArt.Bow, sprite.Head, dy: PetArt.Bow.Dy, dx: sprite.HeadHalfWidth - 2);
                break;
            case PetAccessory.Horns:
            {
                var spread = Math.Max(2, sprite.HeadHalfWidth / 2 - 1);
                var horn = PetArt.Horn;
                foreach (var side in new[] { -1, 1 })
                {
                    var baseX = sprite.Head.X + side * spread;
                    for (var y = 0; y < horn.Height; y++)
                    {
                        for (var x = 0; x < horn.Width; x++)
                        {
                            var key = horn.Key(x, y);
                            if (key == PetArt.K('.')) continue;
                            // Authored as the left horn; mirrored for the right one.
                            var dx = side < 0 ? x - (horn.Width - 1) : horn.Width - 1 - x;
                            SPut(baseX + dx, sprite.Head.Y + 1 - (horn.Height - 1) + y, Color(key));
                        }
                    }
                }
                break;
            }
            default:
            {
                if (!PetArt.Hats.TryGetValue(accessory, out var overlay)) return;
                Stamp(overlay, sprite.Head, dy: overlay.Dy);
                break;
            }
        }
    }

    /// <summary>Bottom-left of the overlay at <paramref name="anchor"/>.</summary>
    private void StampLeft(PetArt.Overlay overlay, PetArt.Point anchor)
    {
        var top = anchor.Y - (overlay.Height - 1);
        for (var y = 0; y < overlay.Height; y++)
        {
            for (var x = 0; x < overlay.Width; x++)
            {
                var key = overlay.Key(x, y);
                if (key != PetArt.K('.')) SPut(anchor.X + x, top + y, Color(key));
            }
        }
    }

    private void DrawGlasses(PetAccessory kind)
    {
        if (sprite.Eyes.Count != 2) return;
        PetArt.Rect a = sprite.Eyes[0], b = sprite.Eyes[1];
        var ink = Outline;
        uint[] fill = kind switch
        {
            PetAccessory.Shades => [Color('k'), Color('k')],
            PetAccessory.Glasses3D => [Color('r'), Color('q')],
            _ => [0, 0],
        };
        PetArt.Rect[] lenses = [a, b];
        for (var i = 0; i < lenses.Length; i++)
        {
            var eye = lenses[i];
            int x0 = eye.X - 1, x1 = eye.X + eye.W, y0 = eye.Y - 1, y1 = eye.Y + eye.H;
            for (var y = y0; y <= y1; y++)
            {
                for (var x = x0; x <= x1; x++)
                {
                    var border = x == x0 || x == x1 || y == y0 || y == y1;
                    var corner = (x == x0 || x == x1) && (y == y0 || y == y1);
                    if (border)
                    {
                        if (kind == PetAccessory.Specs && corner) continue;
                        SPut(x, y, ink);
                    }
                    else if (fill[i] != 0)
                    {
                        SPut(x, y, fill[i]);
                    }
                }
            }
            if (kind == PetAccessory.Shades) SPut(eye.X, eye.Y, Color('w'));
        }
        // Bridge.
        var bridgeY = a.Y - (kind == PetAccessory.Specs ? 0 : 1);
        for (var x = a.X + a.W + 1; x < b.X - 1; x++) SPut(x, bridgeY, ink);
    }

    private void DrawEffect()
    {
        if (frame.Effect == PetEffect.None) return;
        // Effects float in the air next to the head; they don't bob with the body.
        var ax = PetArt.CenterX + sprite.HeadHalfWidth - 1;
        var ay = PetArt.GroundY - (sprite.Height - 1) + sprite.Head.Y;
        var step = frame.EffectStep;
        switch (frame.Effect)
        {
            case PetEffect.Zzz:
                // Small z, then a big Z drifting up and right.
                if (step < 6) StampFree(PetArt.ZSmall, ax, ay - 3 - step / 3);
                if (step >= 2 && step < 7) StampFree(PetArt.ZBig, ax + 3, ay - 8 - (step - 2) / 3);
                break;
            case PetEffect.Heart:
                if (step >= 6) return;
                var glyph = step == 0 ? PetArt.HeartSmall : PetArt.Heart;
                StampFree(glyph, ax + 1, ay - 4 - step);
                break;
            case PetEffect.Dots:
                var bubble = PetArt.Bubble;
                int bx = Math.Min(ax, PetBitmap.Size - bubble.Width), by = Math.Max(ay - 7, 0);
                StampFree(bubble, bx, by);
                var dotInk = colors[PetArt.K('K')];
                for (var i = 0; i < Math.Min(step, 3); i++) Put(bx + 2 + i * 2, by + 2, dotInk);
                break;
        }
    }

    /// <summary>Canvas-space stamp with top-left at (x, y); clipped at the canvas edges.</summary>
    private void StampFree(PetArt.Overlay overlay, int x, int y)
    {
        var maxX = PetBitmap.Size - overlay.Width;
        var left = Math.Min(x, maxX);
        var top = Math.Max(y, 0);
        for (var oy = 0; oy < overlay.Height; oy++)
        {
            for (var ox = 0; ox < overlay.Width; ox++)
            {
                var key = overlay.Key(ox, oy);
                if (key != PetArt.K('.')) Put(left + ox, top + oy, colors[key & 0x7F]);
            }
        }
    }

    private static readonly int[] Reach = [0, 1, 2, 1, 0, -1];

    private void DrawSparkles()
    {
        if (frame.Sparkle is not { } phase) return;
        uint gold = colors[PetArt.K('y')], white = colors[PetArt.K('w')];
        int left = ox - 1, right = Math.Min(ox + sprite.Width, PetArt.CenterX + sprite.HeadHalfWidth + 2);
        var top = PetArt.GroundY - (sprite.Height - 1) + sprite.Head.Y;
        (int X, int Y, int P)[] spots =
        [
            (left, top + 3, phase), (right, top + 8, (phase + 3) % 6), (left + 1, PetArt.GroundY - 2, (phase + 2) % 6),
        ];
        foreach (var (x, y, p) in spots)
        {
            // Swift indexes the table directly (and would trap outside 0..<6); out of range draws nothing here.
            var reach = p is >= 0 and < 6 ? Reach[p] : -1;
            if (reach < 0) continue;
            Put(x, y, reach == 0 ? gold : white);
            for (var d = 1; d <= reach; d++)
            {
                Put(x - d, y, gold); Put(x + d, y, gold); Put(x, y - d, gold); Put(x, y + d, gold);
            }
        }
    }
}
