using System.Security.Cryptography;
using System.Text;
using Cineon.Core.Data;

namespace Cineon.Core.Metadata;

/// <summary>
/// Remote images as bytes, cached in memory and on disk under <c>ImageCache</c> in the data folder,
/// like the Mac's <c>URLCache</c> there (400 MB on disk, 8 MB in memory). A cached copy is used
/// however old it is, as with <c>.returnCacheDataElseLoad</c>. Decoding is the app's job: see
/// <see cref="ImagePipeline{TImage}"/>.
/// </summary>
public sealed class ImageCache
{
    public const long DefaultDiskCapacity = 400L * 1024 * 1024;
    public const long DefaultMemoryCapacity = 8L * 1024 * 1024;

    private static readonly Lazy<ImageCache> SharedCache = new(() => new ImageCache(System.IO.Path.Combine(AppPaths.Root, "ImageCache")));

    /// <summary>The app's cache, in <c>%LOCALAPPDATA%\Cineon\ImageCache</c>.</summary>
    public static ImageCache Shared => SharedCache.Value;

    private readonly HttpClient _http;
    private readonly long _diskCapacity;
    private readonly CostCache<string, byte[]> _memory;
    private readonly Lock _lock = new();
    private readonly Dictionary<string, Task<byte[]?>> _running = [];
    private Dictionary<string, (long Size, DateTime Used)>? _index;
    private long _diskSize;

    /// <param name="directory">Created when first needed.</param>
    /// <param name="handler">Where requests go; tests pass a fake. Null for the network.</param>
    public ImageCache(string directory, HttpMessageHandler? handler = null,
        long diskCapacity = DefaultDiskCapacity, long memoryCapacity = DefaultMemoryCapacity)
    {
        Directory = directory;
        _diskCapacity = diskCapacity;
        _memory = new CostCache<string, byte[]>(memoryCapacity);
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.Timeout = TimeSpan.FromSeconds(15);
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", $"{AppInfo.Name}/1.0");
    }

    public string Directory { get; }

    /// <summary>Bytes on disk, counting only this cache's own files.</summary>
    public long DiskSize
    {
        get
        {
            lock (_lock)
            {
                LoadIndex();
                return _diskSize;
            }
        }
    }

    /// <summary>The image's bytes if they're in memory right now. Never touches the disk or the network.</summary>
    public byte[]? Cached(Uri url) => _memory.Get(Key(url));

    /// <summary>
    /// The image's bytes from memory, disk or the network, in that order. The same address asked for
    /// twice at once is fetched once. Null when it can't be fetched. Like the Mac, a response that isn't
    /// 200 still returns its body (it just isn't kept), and decoding it is what fails.
    /// </summary>
    public Task<byte[]?> DataAsync(Uri url, CancellationToken cancellationToken = default)
    {
        var key = Key(url);
        if (_memory.Get(key) is { } hit) return Task.FromResult<byte[]?>(hit);
        lock (_lock)
        {
            if (_running.TryGetValue(key, out var running)) return running;
            var task = LoadAsync(url, key, cancellationToken);
            if (!task.IsCompleted) _running[key] = task;
            return task;
        }
    }

    private async Task<byte[]?> LoadAsync(Uri url, string key, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Yield();
            var data = await ReadFromDiskAsync(key).ConfigureAwait(false) ?? await DownloadAsync(url, key, cancellationToken).ConfigureAwait(false);
            if (data is not null) _memory.Set(key, data, data.Length, maxCostFraction: 0.05);
            return data;
        }
        finally
        {
            lock (_lock) _running.Remove(key);
        }
    }

    private async Task<byte[]?> DownloadAsync(Uri url, string key, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            var data = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            var noStore = response.Headers.CacheControl?.NoStore == true;
            if ((int)response.StatusCode == 200 && !noStore && data.Length <= _diskCapacity / 20)
            {
                await WriteToDiskAsync(key, data).ConfigureAwait(false);
            }
            return data;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or IOException or InvalidOperationException)
        {
            return null;
        }
    }

    // MARK: Disk

    internal static string Key(Uri url) => url.OriginalString;

    /// <summary>The cache file for an address: the SHA-256 of its text, in hex.</summary>
    internal static string FileName(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)));

    private static bool IsOwnFile(string name) => name.Length == 64 && name.All(char.IsAsciiHexDigitLower);

    private string PathFor(string key) => System.IO.Path.Combine(Directory, FileName(key));

    private async Task<byte[]?> ReadFromDiskAsync(string key)
    {
        var path = PathFor(key);
        lock (_lock)
        {
            LoadIndex();
            if (!_index!.ContainsKey(System.IO.Path.GetFileName(path))) return null;
        }
        try
        {
            var data = await File.ReadAllBytesAsync(path).ConfigureAwait(false);
            var now = DateTime.UtcNow;
            File.SetLastWriteTimeUtc(path, now);
            lock (_lock)
            {
                var name = System.IO.Path.GetFileName(path);
                if (_index!.TryGetValue(name, out var entry)) _index[name] = (entry.Size, now);
            }
            return data;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            lock (_lock) Forget(System.IO.Path.GetFileName(path));
            return null;
        }
    }

    private async Task WriteToDiskAsync(string key, byte[] data)
    {
        var path = PathFor(key);
        var name = System.IO.Path.GetFileName(path);
        var temp = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            System.IO.Directory.CreateDirectory(Directory);
            await File.WriteAllBytesAsync(temp, data).ConfigureAwait(false);
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            try
            {
                File.Delete(temp);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
            return;
        }
        lock (_lock)
        {
            LoadIndex();
            Forget(name);
            _index![name] = (data.Length, DateTime.UtcNow);
            _diskSize += data.Length;
            Trim();
        }
    }

    /// <summary>Reads what's on disk once, so sizes and ages are known without listing it again.</summary>
    private void LoadIndex()
    {
        if (_index is not null) return;
        _index = [];
        _diskSize = 0;
        try
        {
            if (!System.IO.Directory.Exists(Directory)) return;
            foreach (var file in new DirectoryInfo(Directory).EnumerateFiles())
            {
                if (!IsOwnFile(file.Name)) continue;
                _index[file.Name] = (file.Length, file.LastWriteTimeUtc);
                _diskSize += file.Length;
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private void Forget(string name)
    {
        if (_index is not null && _index.Remove(name, out var entry)) _diskSize -= entry.Size;
    }

    /// <summary>Over capacity, the least recently used files go until it's back under 90%.</summary>
    private void Trim()
    {
        if (_diskSize <= _diskCapacity) return;
        foreach (var (name, _) in _index!.OrderBy(pair => pair.Value.Used).ToList())
        {
            if (_diskSize <= _diskCapacity * 9 / 10) break;
            try
            {
                File.Delete(System.IO.Path.Combine(Directory, name));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            Forget(name);
        }
    }
}

/// <summary>
/// Decoded images at display size, kept in memory (200 MB of pixels, like the Mac's
/// <c>NSCache</c>) and fetched once however many views ask at the same time. The app supplies the
/// decoder; the Mac downsamples so the longest side is at most <c>maxPixel</c>, applying the EXIF
/// orientation, off the UI thread.
/// </summary>
public sealed class ImagePipeline<TImage> where TImage : class
{
    public const long DefaultCostLimit = 200L * 1024 * 1024;

    private readonly ImageCache _source;
    private readonly Func<byte[], int, Task<TImage?>> _decode;
    private readonly Func<TImage, long> _cost;
    private readonly CostCache<string, TImage> _memory;
    private readonly Lock _lock = new();
    private readonly Dictionary<string, Task<TImage?>> _running = [];

    /// <param name="source">Where the bytes come from.</param>
    /// <param name="decode">Bytes and the longest side wanted, in pixels, to an image. Null or an exception when it can't.</param>
    /// <param name="cost">What an image costs to keep: its width times height times 4.</param>
    /// <param name="costLimit">How much to keep in memory.</param>
    public ImagePipeline(ImageCache source, Func<byte[], int, Task<TImage?>> decode, Func<TImage, long> cost, long costLimit = DefaultCostLimit)
    {
        _source = source;
        _decode = decode;
        _cost = cost;
        _memory = new CostCache<string, TImage>(costLimit);
    }

    /// <summary>"600|https://…", as on the Mac.</summary>
    public static string Key(Uri url, int maxPixel) => $"{maxPixel}|{url.OriginalString}";

    /// <summary>The image if it's in memory, so a view can show it without a flash.</summary>
    public TImage? Cached(Uri url, int maxPixel) => _memory.Get(Key(url, maxPixel));

    public Task<TImage?> ImageAsync(Uri url, int maxPixel)
    {
        var key = Key(url, maxPixel);
        if (_memory.Get(key) is { } hit) return Task.FromResult<TImage?>(hit);
        lock (_lock)
        {
            if (_running.TryGetValue(key, out var running)) return running;
            var task = LoadAsync(url, maxPixel, key);
            if (!task.IsCompleted) _running[key] = task;
            return task;
        }
    }

    private async Task<TImage?> LoadAsync(Uri url, int maxPixel, string key)
    {
        try
        {
            await Task.Yield();
            if (await _source.DataAsync(url).ConfigureAwait(false) is not { } data) return null;
            TImage? image;
            try
            {
                image = await _decode(data, maxPixel).ConfigureAwait(false);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                return null;
            }
            if (image is not null) _memory.Set(key, image, _cost(image));
            return image;
        }
        finally
        {
            lock (_lock) _running.Remove(key);
        }
    }
}

/// <summary>A colour from 0 to 1 per channel, for ambient light from a poster or a frame.</summary>
public readonly record struct Rgb(double R, double G, double B)
{
    public static readonly Rgb Black = new(0, 0, 0);

    public double Brightness => 0.2126 * R + 0.7152 * G + 0.0722 * B;

    /// <summary>Light from a screen is more saturated than the average pixel value suggests.</summary>
    public Rgb Boosted(double saturation = 1.5)
    {
        var grey = Brightness;
        double Mix(double c) => Math.Min(1, Math.Max(0, grey + (c - grey) * saturation));
        return new Rgb(Mix(R), Mix(G), Mix(B));
    }
}

/// <summary>A memory cache with a total cost, dropping the least recently used entries when it's over.</summary>
internal sealed class CostCache<TKey, TValue>(long costLimit) where TKey : notnull where TValue : class
{
    private readonly Lock _lock = new();
    private readonly Dictionary<TKey, LinkedListNode<(TKey Key, TValue Value, long Cost)>> _map = [];
    private readonly LinkedList<(TKey Key, TValue Value, long Cost)> _order = [];
    private long _total;

    public long TotalCost
    {
        get
        {
            lock (_lock) return _total;
        }
    }

    public TValue? Get(TKey key)
    {
        lock (_lock)
        {
            if (!_map.TryGetValue(key, out var node)) return null;
            _order.Remove(node);
            _order.AddFirst(node);
            return node.Value.Value;
        }
    }

    /// <param name="maxCostFraction">Entries costing more than this share of the limit aren't kept.</param>
    public void Set(TKey key, TValue value, long cost, double maxCostFraction = 1)
    {
        lock (_lock)
        {
            if (_map.Remove(key, out var old))
            {
                _order.Remove(old);
                _total -= old.Value.Cost;
            }
            if (cost > costLimit * maxCostFraction) return;
            _map[key] = _order.AddFirst((key, value, cost));
            _total += cost;
            while (_total > costLimit && _order.Last is { } last)
            {
                _order.RemoveLast();
                _map.Remove(last.Value.Key);
                _total -= last.Value.Cost;
            }
        }
    }
}
