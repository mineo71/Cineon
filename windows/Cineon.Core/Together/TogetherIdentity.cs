using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using Cineon.Core.Data;

namespace Cineon.Core.Together;

// Port of TogetherIdentity at the bottom of Cineon/Core/TogetherClient.swift. The file is
// Profiles\<UUID>\together.json, written the way Swift's JSONEncoder writes the struct:
// {"secret":"…","name":"…","personId":"…","openedShares":["K7Q2MX"],"partyCode":"…","pet":"…"}, with
// absent optionals left out. A profile folder copied from a Mac keeps its identity.

/// <summary>Who this profile is to the server: a random key and a name, kept in the profile's folder.</summary>
public sealed class TogetherIdentity
{
    public const string FileName = "together.json";

    /// <summary>32 random bytes in standard base64 (44 characters). The server keeps only its SHA-256.</summary>
    public string Secret { get; set; } = "";
    public string Name { get; set; } = "";
    public string? PersonId { get; set; }
    /// <summary>Codes of friends' lists opened here, newest first, at most 20.</summary>
    public List<string> OpenedShares { get; set; } = [];
    public string? PartyCode { get; set; }
    /// <summary>The pixel pet's code as the server last heard it.</summary>
    public string? Pet { get; set; }

    /// <summary>The identity file of a profile.</summary>
    public static string FileFor(Guid profileId) => Path.Combine(AppPaths.Profile(profileId), FileName);

    /// <summary>The stored identity, or a new one (saved straight away) when there's none or it can't be read.</summary>
    public static TogetherIdentity Load(Data.Profile profile) => Load(FileFor(profile.Id), profile.Name);

    public void Save(Guid profileId) => Save(FileFor(profileId));

    internal static TogetherIdentity Load(string file, string name)
    {
        try
        {
            if (Decode(File.ReadAllBytes(file)) is { } stored) return stored;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
        // Like the Mac, a file that can't be read is replaced by a new identity.
        var identity = new TogetherIdentity { Secret = NewSecret(), Name = name };
        identity.Save(file);
        return identity;
    }

    internal static string NewSecret() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    internal void Save(string file)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            // Atomic, as the Mac's `.atomic` write: a temporary file next to it, then a rename.
            var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllBytes(temporary, Encode());
            File.Move(temporary, file, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    internal byte[] Encode()
    {
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartObject();
            w.WriteString("secret", Secret);
            w.WriteString("name", Name);
            if (PersonId is not null) w.WriteString("personId", PersonId);
            // Always written: the Mac's decoder requires it.
            w.WriteStartArray("openedShares");
            foreach (var code in OpenedShares) w.WriteStringValue(code);
            w.WriteEndArray();
            if (PartyCode is not null) w.WriteString("partyCode", PartyCode);
            if (Pet is not null) w.WriteString("pet", Pet);
            w.WriteEndObject();
        }
        return stream.ToArray();
    }

    /// <summary>Reads the Mac's file. Null when it isn't one; a missing <c>openedShares</c> is forgiven.</summary>
    internal static TogetherIdentity? Decode(byte[] data)
    {
        try
        {
            using var document = JsonDocument.Parse(data);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            var shares = new List<string>();
            if (root.TryGetProperty("openedShares", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in list.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String) return null;
                    shares.Add(item.GetString()!);
                }
            }
            return new TogetherIdentity
            {
                Secret = JsonRead.String(root, "secret"),
                Name = JsonRead.String(root, "name"),
                PersonId = JsonRead.OptionalString(root, "personId"),
                OpenedShares = shares,
                PartyCode = JsonRead.OptionalString(root, "partyCode"),
                Pet = JsonRead.OptionalString(root, "pet"),
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Foundation's <c>Data(base64Encoded:)</c> with no options: the standard alphabet, padded to a
    /// multiple of four, no whitespace. (.NET's decoder skips whitespace, so it can't be used.)
    /// </summary>
    internal static bool IsStrictBase64(string text)
    {
        if (text.Length % 4 != 0) return false;
        var padding = text.EndsWith("==", StringComparison.Ordinal) ? 2 : text.EndsWith('=') ? 1 : 0;
        for (var i = 0; i < text.Length - padding; i++)
        {
            var c = text[i];
            if (!(char.IsAsciiLetterOrDigit(c) || c == '+' || c == '/')) return false;
        }
        return true;
    }
}
