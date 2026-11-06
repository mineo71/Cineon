using System.Collections.Concurrent;
using System.Net;
using System.Text;

namespace Cineon.Core.Tests.Metadata;

/// <summary>Answers requests from a table instead of the network, and remembers what was asked.</summary>
internal sealed class FakeHttp : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _answer;

    public FakeHttp(Func<HttpRequestMessage, HttpResponseMessage> answer) => _answer = request => Task.FromResult(answer(request));

    private FakeHttp(Func<HttpRequestMessage, Task<HttpResponseMessage>> answer, bool _) => _answer = answer;

    /// <summary>Answers that take their time, to catch requests made twice.</summary>
    public static FakeHttp Async(Func<HttpRequestMessage, Task<HttpResponseMessage>> answer) => new(answer, true);

    /// <summary>Exact addresses to bodies; anything else is a 404.</summary>
    public static FakeHttp Routes(Dictionary<string, string> routes) => new(request =>
        routes.TryGetValue(request.RequestUri!.AbsoluteUri, out var body) ? Json(body) : new HttpResponseMessage(HttpStatusCode.NotFound));

    public ConcurrentQueue<HttpRequestMessage> Requests { get; } = new();

    public IEnumerable<string> Addresses => Requests.Select(r => r.RequestUri!.AbsoluteUri);

    public static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Bytes(byte[] body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new ByteArrayContent(body) };

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Enqueue(request);
        return _answer(request);
    }
}
