using System.Net;
using System.Net.Http.Headers;
using Cineon.Core.Metadata;
using Cineon.Core.Tests.Data;

namespace Cineon.Core.Tests.Metadata;

public sealed class ImageCacheTests : IDisposable
{
    private static readonly Uri Poster = new("https://m.media-amazon.com/images/M/poster._V1_QL75_UX500_.jpg");
    private readonly TempFolder _folder = new();

    public void Dispose() => _folder.Dispose();

    private string Directory => _folder.File("ImageCache");

    private static byte[] Image(int size, byte fill = 7) => Enumerable.Repeat(fill, size).ToArray();

    [Fact]
    public async Task OneFetchServesEveryoneAndIsKeptOnDisk()
    {
        var release = new TaskCompletionSource();
        var http = FakeHttp.Async(async _ =>
        {
            await release.Task;
            return FakeHttp.Bytes(Image(100));
        });
        var cache = new ImageCache(Directory, http);

        var first = cache.DataAsync(Poster);
        var second = cache.DataAsync(Poster);
        release.SetResult();
        Assert.Equal(Image(100), await first);
        Assert.Equal(Image(100), await second);
        Assert.Single(http.Requests);

        Assert.Equal(Image(100), cache.Cached(Poster));
        var file = Path.Combine(Directory, ImageCache.FileName(Poster.OriginalString));
        Assert.True(File.Exists(file));
        Assert.Equal(100, cache.DiskSize);

        // A new cache over the same folder, as after a restart, reads it from disk.
        var offline = new ImageCache(Directory, new FakeHttp(_ => throw new HttpRequestException("offline")));
        Assert.Null(offline.Cached(Poster));
        Assert.Equal(Image(100), await offline.DataAsync(Poster));
    }

    [Fact]
    public async Task OnlyGoodResponsesAreKept()
    {
        var notFound = new FakeHttp(_ => FakeHttp.Bytes(Image(10), HttpStatusCode.NotFound));
        // Like the Mac, the body still comes back; decoding it is what fails.
        Assert.Equal(Image(10), await new ImageCache(Directory, notFound).DataAsync(Poster));
        Assert.Equal(0, new ImageCache(Directory).DiskSize);

        var noStore = new FakeHttp(_ =>
        {
            var response = FakeHttp.Bytes(Image(10));
            response.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
            return response;
        });
        await new ImageCache(Directory, noStore).DataAsync(Poster);
        Assert.Equal(0, new ImageCache(Directory).DiskSize);

        Assert.Null(await new ImageCache(Directory, new FakeHttp(_ => throw new HttpRequestException("offline"))).DataAsync(Poster));
    }

    [Fact]
    public async Task TheLeastRecentlyUsedGoWhenTheDiskIsFull()
    {
        var http = new FakeHttp(request => FakeHttp.Bytes(Image(400, (byte)request.RequestUri!.AbsolutePath.Length)));
        var cache = new ImageCache(Directory, http, diskCapacity: 20_000, memoryCapacity: 1);
        System.IO.Directory.CreateDirectory(Directory);
        File.WriteAllBytes(Path.Combine(Directory, "Cache.db"), Image(5000)); // A Mac's URLCache files are left alone

        var urls = Enumerable.Range(0, 55).Select(i => new Uri($"https://img.example/{i}.jpg")).ToList();
        foreach (var url in urls.Take(10)) await cache.DataAsync(url);
        await Task.Delay(20);
        await cache.DataAsync(urls[0]); // Used again, so it stays
        foreach (var url in urls.Skip(10)) await cache.DataAsync(url);

        Assert.True(cache.DiskSize <= 20_000, $"{cache.DiskSize} bytes on disk");
        Assert.True(File.Exists(Path.Combine(Directory, ImageCache.FileName(urls[0].OriginalString))));
        Assert.False(File.Exists(Path.Combine(Directory, ImageCache.FileName(urls[1].OriginalString))));
        Assert.True(File.Exists(Path.Combine(Directory, ImageCache.FileName(urls[^1].OriginalString))));
        Assert.True(File.Exists(Path.Combine(Directory, "Cache.db")));
    }

    [Fact]
    public async Task ThePipelineDecodesOncePerSize()
    {
        var http = new FakeHttp(_ => FakeHttp.Bytes(Image(64)));
        var decodes = 0;
        var pipeline = new ImagePipeline<string>(
            new ImageCache(Directory, http),
            async (data, maxPixel) =>
            {
                Interlocked.Increment(ref decodes);
                await Task.Delay(10);
                return $"{data.Length}@{maxPixel}";
            },
            image => 4);

        Assert.Null(pipeline.Cached(Poster, 600));
        var results = await Task.WhenAll(pipeline.ImageAsync(Poster, 600), pipeline.ImageAsync(Poster, 600));
        Assert.Equal(["64@600", "64@600"], results);
        Assert.Equal(1, decodes);
        Assert.Equal("64@600", pipeline.Cached(Poster, 600));
        Assert.Equal("600|" + Poster.OriginalString, ImagePipeline<string>.Key(Poster, 600));

        Assert.Equal("64@256", await pipeline.ImageAsync(Poster, 256));
        Assert.Equal(2, decodes);
        Assert.Single(http.Requests); // The bytes were fetched once
    }

    [Fact]
    public async Task WhatCantBeDecodedIsNotKept()
    {
        var pipeline = new ImagePipeline<string>(
            new ImageCache(Directory, new FakeHttp(_ => FakeHttp.Bytes(Image(8)))),
            (_, _) => throw new InvalidDataException("not an image"),
            _ => 1);
        Assert.Null(await pipeline.ImageAsync(Poster, 600));
        Assert.Null(pipeline.Cached(Poster, 600));
    }

    [Fact]
    public void MemoryKeepsTheMostRecentlyUsedWithinItsLimit()
    {
        var cache = new CostCache<string, string>(10);
        cache.Set("a", "A", 4);
        cache.Set("b", "B", 4);
        Assert.Equal("A", cache.Get("a"));
        cache.Set("c", "C", 4);
        Assert.Null(cache.Get("b"));
        Assert.Equal("A", cache.Get("a"));
        Assert.Equal(8, cache.TotalCost);
        cache.Set("huge", "H", 11);
        Assert.Null(cache.Get("huge"));
    }

    [Fact]
    public void AmbientColoursAreBoosted()
    {
        Assert.Equal(0, Rgb.Black.Brightness);
        Assert.Equal(1, new Rgb(1, 1, 1).Brightness, 6);
        var boosted = new Rgb(0.8, 0.3, 0.1).Boosted();
        var grey = new Rgb(0.8, 0.3, 0.1).Brightness;
        Assert.Equal(Math.Min(1, grey + (0.8 - grey) * 1.5), boosted.R, 9);
        Assert.Equal(Math.Max(0, grey + (0.1 - grey) * 1.5), boosted.B, 9);
        Assert.Equal(new Rgb(0.5, 0.5, 0.5), new Rgb(0.5, 0.5, 0.5).Boosted());
    }
}
