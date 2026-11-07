using System.Diagnostics;
using System.Globalization;
using System.Numerics;
using Cineon.Core.Profile;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Brushes;
using Microsoft.Graphics.Canvas.Effects;
using Microsoft.Graphics.Canvas.Geometry;
using Microsoft.Graphics.Canvas.Text;
using Microsoft.UI.Text;
using Windows.UI;
using Colors = Microsoft.UI.Colors;

namespace Cineon.App.UI;

/// A picture of your profile to post or send: pet, top numbers and taste. ProfileView.swift's
/// ShareCardView and ShareCard, drawn with Win2D at twice the size, the Mac's `renderer.scale = 2`,
/// always on the dark palette. Win2D rather than a XAML capture so the pet's pixels land on whole
/// device pixels whatever the screen's scale.
internal static class ShareCard
{
    private const float Width = 720;
    private const float Pad = 36;
    private const string Jost = "ms-appx:///Assets/Fonts/Jost.ttf#Jost";
    private const string Segoe = "Segoe UI";

    /// Renders the card and asks where to save it, then shows it in File Explorer.
    public static async Task ExportAsync(AppModel app, ProfileStats stats, PixelPet pet, string name)
    {
        byte[] png;
        try
        {
            png = await RenderAsync(stats, pet, name);
        }
        catch (Exception error)
        {
            CrashLog.Write("share card", error);
            return;
        }
        if (app.Window is not { } window) return;
        var picker = new Microsoft.Windows.Storage.Pickers.FileSavePicker(window.AppWindow.Id)
        {
            SuggestedFileName = $"{name} on Cineon",
            DefaultFileExtension = ".png",
        };
        picker.FileTypeChoices.Add("PNG image", new List<string> { ".png" });
        var result = await picker.PickSaveFileAsync();
        if (result is null || string.IsNullOrEmpty(result.Path)) return;
        try
        {
            await File.WriteAllBytesAsync(result.Path, png);
        }
        catch (Exception)
        {
            return;
        }
        Reveal(result.Path);
    }

    /// The Mac's `activateFileViewerSelecting`.
    public static void Reveal(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
        }
        catch (Exception)
        {
        }
    }

    private static Color White(double opacity) => Palette.Grey(1, opacity);

    private static CanvasTextLayout Text(ICanvasResourceCreator device, string text, string family, float size, Windows.UI.Text.FontWeight weight,
        Color color, float maxWidth = 10000, CanvasHorizontalAlignment align = CanvasHorizontalAlignment.Left)
    {
        var format = new CanvasTextFormat
        {
            FontFamily = family,
            FontSize = size,
            FontWeight = weight,
            WordWrapping = CanvasWordWrapping.NoWrap,
            HorizontalAlignment = align,
        };
        // Win2D rejects a width that isn't positive and finite.
        if (!float.IsFinite(maxWidth) || maxWidth < 1) maxWidth = maxWidth < 1 ? 1 : 10000;
        var layout = new CanvasTextLayout(device, text, format, maxWidth, 10000) { Options = CanvasDrawTextOptions.EnableColorFont };
        layout.SetColor(0, text.Length, color);
        return layout;
    }

    private static float W(CanvasTextLayout layout) => (float)layout.LayoutBounds.Width;
    private static float H(CanvasTextLayout layout) => (float)layout.LayoutBounds.Height;
    private static float Baseline(CanvasTextLayout layout) => layout.LineMetrics.Length > 0 ? layout.LineMetrics[0].Baseline : H(layout);

    /// To the half view pixel, so at scale 2 everything starts on a whole pixel.
    private static float Snap(float value) => MathF.Round(value * 2) / 2;

    public static async Task<byte[]> RenderAsync(ProfileStats stats, PixelPet pet, string name, DateTimeOffset? now = null)
    {
        var device = CanvasDevice.GetSharedDevice();
        var dark = Palette.Dark;
        var draws = new List<Action<CanvasDrawingSession>>();
        var y = Pad;

        // Logo, name of the app, the month.
        CanvasBitmap? logo = null;
        try
        {
            logo = await CanvasBitmap.LoadAsync(device, Path.Combine(AppContext.BaseDirectory, "Assets", "logo-mark.png"));
        }
        catch (Exception)
        {
            // The card is still a card without the mark.
        }
        var date = (now ?? DateTimeOffset.Now).ToString(CultureInfo.CurrentCulture.DateTimeFormat.YearMonthPattern, CultureInfo.CurrentCulture);
        var brand = Text(device, "Cineon", Jost, 17, FontWeights.Bold, Colors.White);
        var month = Text(device, date, Segoe, 13, FontWeights.Normal, White(0.5));
        var h1 = Math.Max(20, Math.Max(H(brand), H(month)));
        {
            var top = y;
            draws.Add(ds =>
            {
                if (logo is not null)
                {
                    var white = new ColorMatrixEffect
                    {
                        Source = logo,
                        ColorMatrix = new Matrix5x4 { M44 = 1, M51 = 1, M52 = 1, M53 = 1 },
                    };
                    ds.DrawImage(white, new Windows.Foundation.Rect(Pad, top + (h1 - 20) / 2, 20, 20), logo.Bounds, 1, CanvasImageInterpolation.HighQualityCubic);
                }
                ds.DrawTextLayout(brand, Pad + 20 + 8, top + (h1 - H(brand)) / 2, Colors.White);
                ds.DrawTextLayout(month, Width - Pad - W(month), top + (h1 - H(month)) / 2, White(0.5));
            });
        }
        y += h1 + 22;

        // The pet and who it belongs to.
        var lines = new List<CanvasTextLayout>
        {
            Text(device, name, Jost, 40, FontWeights.Medium, Colors.White),
            Text(device, $"{pet.Name}, {pet.StageLabel.ToLowerInvariant()} {pet.SpeciesLabel.ToLowerInvariant()}", Segoe, 15, FontWeights.Normal, White(0.7)),
        };
        if (stats.FavouriteGenre is { } genre) lines.Add(Text(device, $"Mostly {genre.ToLowerInvariant()}", Segoe, 15, FontWeights.Normal, White(0.7)));
        var columnHeight = lines.Sum(H) + 6 * (lines.Count - 1);
        var h2 = Math.Max(150, columnHeight);
        {
            var top = y;
            draws.Add(ds =>
            {
                var petX = Snap(Pad);
                var petY = Snap(top + (h2 - 150) / 2);
                var frame = PetCanvas.FrameFor(pet, 150, PetFraming.Automatic, animated: false);
                var fills = PetCanvas.Layout(pet.Bitmap(frame), PetCrop.Canvas, 150, 150, 2);
                ds.Antialiasing = CanvasAntialiasing.Aliased;
                foreach (var fill in fills)
                {
                    var c = fill.Argb;
                    ds.FillRectangle(petX + (float)fill.X, petY + (float)fill.Y, (float)fill.Width, (float)fill.Height,
                        Color.FromArgb((byte)(c >> 24), (byte)(c >> 16), (byte)(c >> 8), (byte)c));
                }
                ds.Antialiasing = CanvasAntialiasing.Antialiased;
                var x = Pad + 150 + 26;
                var lineY = top + (h2 - columnHeight) / 2;
                foreach (var line in lines)
                {
                    ds.DrawTextLayout(line, x, lineY, Colors.White);
                    lineY += H(line) + 6;
                }
            });
        }
        y += h2 + 22;

        // The numbers.
        var numbers = new List<(CanvasTextLayout Value, CanvasTextLayout Label, bool Star)>
        {
            (Text(device, ProfileBody.Hours(stats.EstimatedHours), Jost, 30, FontWeights.Bold, Colors.White), Text(device, "hours", Segoe, 12, FontWeights.Normal, White(0.55)), false),
            (Text(device, $"{stats.FilmsWatched}", Jost, 30, FontWeights.Bold, Colors.White), Text(device, "films", Segoe, 12, FontWeights.Normal, White(0.55)), false),
            (Text(device, $"{stats.EpisodesFinished}", Jost, 30, FontWeights.Bold, Colors.White), Text(device, "episodes", Segoe, 12, FontWeights.Normal, White(0.55)), false),
            (Text(device, stats.AverageRating is { } average ? average.ToString("0.0", CultureInfo.InvariantCulture) : "–", Jost, 30, FontWeights.Bold, Colors.White),
                Text(device, "average", Segoe, 12, FontWeights.Normal, White(0.55)), true),
        };
        var h3 = numbers.Max(n => H(n.Value) + 2 + H(n.Label));
        {
            var top = y;
            draws.Add(ds =>
            {
                var x = Pad;
                foreach (var (value, label, star) in numbers)
                {
                    var height = H(value) + 2 + H(label);
                    var columnTop = top + (h3 - height) / 2;
                    var valueX = x;
                    var width = Math.Max(W(value), W(label));
                    if (star)
                    {
                        // Gold only for ratings: the star the Mac draws at 18 pt.
                        var centre = new Vector2(x + 9, columnTop + H(value) / 2 + 1);
                        DrawStar(ds, centre, 9, dark);
                        valueX = x + 18 + 5;
                        width = Math.Max(18 + 5 + W(value), W(label));
                    }
                    ds.DrawTextLayout(value, valueX, columnTop, Colors.White);
                    ds.DrawTextLayout(label, x, columnTop + H(value) + 2, White(0.55));
                    x += width + 34;
                }
            });
        }
        y += h3 + 22;

        // Taste: the profile page's genre bars, five of them, on the dark palette.
        var genres = stats.Genres.Take(5).ToList();
        var title = Text(device, "Your taste", Jost, 22, FontWeights.Medium, Colors.White);
        var detail = genres.Count > 0 ? Text(device, $"mostly {genres[0].Name.ToLowerInvariant()}", Segoe, 12.5f, FontWeights.Normal, dark.Ink3) : null;
        var baseline = Math.Max(Baseline(title), detail is null ? 0 : Baseline(detail));
        var titleHeight = Math.Max(baseline - Baseline(title) + H(title), detail is null ? 0 : baseline - Baseline(detail) + H(detail));
        {
            var top = y;
            draws.Add(ds =>
            {
                ds.DrawTextLayout(title, Pad, top + baseline - Baseline(title), Colors.White);
                if (detail is not null) ds.DrawTextLayout(detail, Pad + W(title) + 10, top + baseline - Baseline(detail), dark.Ink3);
            });
        }
        y += titleHeight + 16;
        if (genres.Count == 0)
        {
            var empty = Text(device, "Genres appear once Cineon has found your films' details.", Segoe, 12.5f, FontWeights.Normal, dark.Ink3);
            var top = y;
            draws.Add(ds => ds.DrawTextLayout(empty, Pad, top, dark.Ink3));
            y += H(empty);
        }
        else
        {
            var most = genres[0].Weight > 0 ? genres[0].Weight : 1;
            var trackX = Pad + 92 + 12;
            var trackWidth = Width - Pad - 34 - 12 - trackX;
            for (var i = 0; i < genres.Count; i++)
            {
                var item = genres[i];
                var percent = (int)Math.Round(item.Weight * 100, MidpointRounding.AwayFromZero);
                var label = Text(device, item.Name, Segoe, 12.5f, FontWeights.Normal, dark.Ink2, 92);
                var value = Text(device, $"{percent}%", Segoe, 11.5f, FontWeights.Normal, dark.Ink3, 34, CanvasHorizontalAlignment.Right);
                var rowHeight = Math.Max(10, Math.Max(H(label), H(value)));
                var top = y;
                var first = i == 0;
                var barWidth = (float)Math.Max(3, trackWidth * item.Weight / most);
                draws.Add(ds =>
                {
                    ds.DrawTextLayout(label, Pad, top + (rowHeight - H(label)) / 2, dark.Ink2);
                    var barY = top + (rowHeight - 10) / 2;
                    using var path = RightRounded(ds, trackX, barY, barWidth, 10, 4);
                    if (first)
                    {
                        using var silver = new CanvasLinearGradientBrush(ds, dark.SilverTop, dark.SilverBottom)
                        {
                            StartPoint = new Vector2(0, barY),
                            EndPoint = new Vector2(0, barY + 10),
                        };
                        ds.FillGeometry(path, silver);
                    }
                    else
                    {
                        ds.FillGeometry(path, Palette.WithOpacity(dark.Ink, 0.32));
                    }
                    ds.DrawTextLayout(value, Width - Pad - 34, top + (rowHeight - H(value)) / 2, dark.Ink3);
                });
                y += rowHeight + (i < genres.Count - 1 ? 9 : 0);
            }
        }
        var height = MathF.Ceiling(y + Pad);

        using var target = new CanvasRenderTarget(device, Width, height, 192);
        using (var ds = target.CreateDrawingSession())
        {
            using var background = new CanvasLinearGradientBrush(ds, Palette.Grey(0.1), Colors.Black)
            {
                StartPoint = new Vector2(0, 0),
                EndPoint = new Vector2(0, height),
            };
            ds.FillRectangle(0, 0, Width, height, background);
            foreach (var draw in draws) draw(ds);
        }
        using var stream = new MemoryStream();
        await target.SaveAsync(stream.AsRandomAccessStream(), CanvasBitmapFileFormat.Png);
        logo?.Dispose();
        return stream.ToArray();
    }

    /// A bar with its right end rounded, like the Mac's UnevenRoundedRectangle.
    private static CanvasGeometry RightRounded(ICanvasResourceCreator device, float x, float y, float width, float height, float radius)
    {
        var r = Math.Min(radius, Math.Min(width, height / 2));
        using var builder = new CanvasPathBuilder(device);
        builder.BeginFigure(x, y);
        builder.AddLine(x + width - r, y);
        builder.AddArc(new Vector2(x + width, y + r), r, r, 0, CanvasSweepDirection.Clockwise, CanvasArcSize.Small);
        builder.AddLine(x + width, y + height - r);
        builder.AddArc(new Vector2(x + width - r, y + height), r, r, 0, CanvasSweepDirection.Clockwise, CanvasArcSize.Small);
        builder.AddLine(x, y + height);
        builder.EndFigure(CanvasFigureLoop.Closed);
        return CanvasGeometry.CreatePath(builder);
    }

    /// SF Symbols' star.fill in the award gold.
    private static void DrawStar(CanvasDrawingSession ds, Vector2 centre, float radius, Palette palette)
    {
        var points = new Vector2[10];
        for (var i = 0; i < 10; i++)
        {
            var angle = -MathF.PI / 2 + i * MathF.PI / 5;
            var r = i % 2 == 0 ? radius : radius * 0.48f;
            points[i] = centre + new Vector2(MathF.Cos(angle) * r, MathF.Sin(angle) * r);
        }
        using var star = CanvasGeometry.CreatePolygon(ds, points);
        var top = palette.IsDark ? Palette.Rgb(1, 0.86, 0.5) : Palette.Rgb(0.93, 0.69, 0.2);
        var bottom = palette.IsDark ? Palette.Rgb(0.93, 0.66, 0.22) : Palette.Rgb(0.74, 0.5, 0.08);
        using var gold = new CanvasLinearGradientBrush(ds, top, bottom)
        {
            StartPoint = new Vector2(0, centre.Y - radius),
            EndPoint = new Vector2(0, centre.Y + radius),
        };
        ds.FillGeometry(star, gold);
    }
}
