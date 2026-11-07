// Asks the Windows port's shield engine (Cineon.Core.Shields, itself checked against the Mac's
// WebKit rules) the questions in <input dir>, and writes its answers as the extension's fixture:
// rule counts per bundled list, block or allow for each request on the sampled lists, and a hash of
// CssFor(host) on the full lists.
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cineon.Core.Shields;

var input = args[0];
var output = args[1];
// The fixture lives in extension/test/shields/fixtures; the lists in Cineon/Resources/Filters.
var filters = args.Length > 2 ? args[2] : Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(output))!, "../../../../Cineon/Resources/Filters"));

var full = FilterEngine.Catalog.Select(i => (i.Id, Text: File.ReadAllText(Path.Combine(filters, $"{i.Id}.txt")))).ToArray();
var sampled = FilterEngine.Catalog.Select(i => (i.Id, Text: File.ReadAllText(Path.Combine(input, "sampled", $"{i.Id}.txt")))).ToArray();

var lists = new JsonObject();
foreach (var (id, text) in full)
{
    var list = FilterList.Compile(id, text);
    lists[id] = new JsonObject
    {
        ["ruleCount"] = list.RuleCount,
        ["skipped"] = list.Skipped,
        ["blocks"] = list.BlockCount,
        ["exceptions"] = list.ExceptionCount,
        ["cosmetic"] = list.CosmeticCount,
    };
}

// The requests aren't stored, only a hash of them: the test makes the same ones from corpus.ts.
var engine = ShieldEngine.Load(sampled.Select(l => (l.Id, l.Text)));
var requestsJson = File.ReadAllText(Path.Combine(input, "requests.json"));
var decisions = new StringBuilder();
using (var doc = JsonDocument.Parse(requestsJson))
{
    foreach (var r in doc.RootElement.EnumerateArray())
    {
        var url = r.GetProperty("url").GetString()!;
        var page = r.GetProperty("page").ValueKind == JsonValueKind.Null ? null : r.GetProperty("page").GetString();
        var type = Enum.Parse<ResourceType>(r.GetProperty("type").GetString()!);
        var mainFrame = r.GetProperty("mainFrame").GetBoolean();
        decisions.Append(engine.Match(url, page, type, mainFrame) == Decision.Block ? '1' : '0');
    }
}

var all = ShieldEngine.Load(full.Select(l => (l.Id, l.Text)));
var css = new JsonArray();
using (var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(input, "hosts.json"))))
{
    foreach (var h in doc.RootElement.EnumerateArray())
    {
        var host = h.GetString()!;
        var text = all.CssFor(host);
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16];
        css.Add(new JsonArray(host, text.Length, hash));
    }
}

static string Sha(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

var fixture = new JsonObject
{
    ["about"] = "Answers from windows/Cineon.Core.Shields, written by test/shields/apps-parity. Requests use the sampled lists, CSS the full ones.",
    ["lists"] = lists,
    ["requestsSha256"] = Sha(requestsJson),
    ["decisions"] = decisions.ToString(),
    ["css"] = css,
};
File.WriteAllText(output, fixture.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine($"{decisions.Length} requests, {decisions.ToString().Count(c => c == '1')} blocked; {css.Count} hosts -> {output}");
