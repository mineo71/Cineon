using System.ComponentModel;
using System.Text.Json;

namespace Cineon.Core.Data;

// Port of Cineon/App/ProfileStore.swift. profiles.json keeps the Mac's shape:
// {"profiles":[{"id":"UUID","name":"…","createdAt":<seconds since 2001>,"lastPosterURL":"…"}],
//  "lastUsedID":"UUID","askOnLaunch":false}, with absent optionals left out.

public sealed record Profile
{
    public Guid Id { get; init; }
    public string Name { get; init; } = "";
    public DateTimeOffset CreatedAt { get; init; }
    /// <summary>The last poster this person watched. Their avatar on the picker, so it's always current.</summary>
    public Uri? LastPosterUrl { get; init; }
}

/// <summary>The list of people using this PC. Everything else about a profile lives in its own database.</summary>
public sealed class ProfileStore : INotifyPropertyChanged
{
    private readonly List<Profile> _profiles = [];
    private bool _askOnLaunch;

    /// <summary>The data folder holding <c>profiles.json</c> and <c>Profiles</c>.</summary>
    public string Root { get; }

    public IReadOnlyList<Profile> Profiles => _profiles;
    public Guid? LastUsedId { get; private set; }

    public bool AskOnLaunch
    {
        get => _askOnLaunch;
        set
        {
            _askOnLaunch = value;
            Save();
            Notify(nameof(AskOnLaunch));
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>Raised once after anything in the store changed.</summary>
    public event EventHandler? Changed;

    public string FilePath => Path.Combine(Root, "profiles.json");

    public ProfileStore() : this(AppPaths.Root)
    {
    }

    /// <summary>A store kept in <paramref name="root"/> instead of <see cref="AppPaths.Root"/>.</summary>
    public ProfileStore(string root)
    {
        Root = root;
        if (Load(FilePath) is { Profiles.Count: > 0 } stored)
        {
            _profiles.AddRange(stored.Profiles);
            LastUsedId = stored.LastUsedId;
            _askOnLaunch = stored.AskOnLaunch;
        }
        else
        {
            var accountName = Environment.UserName.Split(' ').FirstOrDefault(part => part.Length > 0) ?? "Me";
            var first = new Profile
            {
                Id = Guid.NewGuid(),
                Name = char.ToUpperInvariant(accountName[0]) + accountName[1..],
                CreatedAt = DateTimeOffset.UtcNow,
            };
            _profiles.Add(first);
            LastUsedId = first.Id;
            _askOnLaunch = false;
            Save();
        }
    }

    public Profile LastUsed => _profiles.FirstOrDefault(p => p.Id == LastUsedId) ?? _profiles[0];

    public void MarkUsed(Guid id)
    {
        LastUsedId = id;
        Save();
        Notify(nameof(LastUsedId));
    }

    public Profile Add(string name)
    {
        var profile = new Profile { Id = Guid.NewGuid(), Name = name, CreatedAt = DateTimeOffset.UtcNow };
        _profiles.Add(profile);
        // More than one person now, so ask who's watching next time.
        if (_profiles.Count == 2) _askOnLaunch = true;
        Save();
        Notify(nameof(Profiles), nameof(AskOnLaunch));
        return profile;
    }

    public void Rename(Guid id, string name)
    {
        var index = _profiles.FindIndex(p => p.Id == id);
        if (index < 0) return;
        _profiles[index] = _profiles[index] with { Name = name };
        Save();
        Notify(nameof(Profiles));
    }

    public void SetPoster(Guid id, Uri? url)
    {
        var index = _profiles.FindIndex(p => p.Id == id);
        if (index < 0 || _profiles[index].LastPosterUrl?.OriginalString == url?.OriginalString) return;
        _profiles[index] = _profiles[index] with { LastPosterUrl = url };
        Save();
        Notify(nameof(Profiles));
    }

    /// <summary>The person's folder, <c>Profiles\&lt;UUID&gt;</c> under <see cref="Root"/>, created on first use.</summary>
    public string ProfileDirectory(Guid id) => AppPaths.ProfileDirectory(Root, id);

    /// <summary>Removes the person and everything they did, including their cookies and logins.</summary>
    public void Delete(Guid id)
    {
        if (_profiles.Count <= 1) return;
        _profiles.RemoveAll(p => p.Id == id);
        if (LastUsedId == id) LastUsedId = _profiles.FirstOrDefault()?.Id;
        try
        {
            var dir = Path.Combine(Root, "Profiles", Database.UuidString(id));
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
        Save();
        Notify(nameof(Profiles), nameof(LastUsedId));
    }

    private void Notify(params string[] properties)
    {
        foreach (var property in properties) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(property));
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Root);
            var temp = FilePath + ".tmp";
            File.WriteAllBytes(temp, Encode(_profiles, LastUsedId, _askOnLaunch));
            File.Move(temp, FilePath, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    // MARK: profiles.json

    internal sealed record Stored(List<Profile> Profiles, Guid? LastUsedId, bool AskOnLaunch);

    internal static byte[] Encode(IEnumerable<Profile> profiles, Guid? lastUsedId, bool askOnLaunch)
    {
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream))
        {
            w.WriteStartObject();
            w.WriteStartArray("profiles");
            foreach (var p in profiles)
            {
                w.WriteStartObject();
                w.WriteString("id", Database.UuidString(p.Id));
                w.WriteString("name", p.Name);
                w.WriteNumber("createdAt", StoredDate.ToReference(p.CreatedAt));
                if (p.LastPosterUrl is not null) w.WriteString("lastPosterURL", p.LastPosterUrl.OriginalString);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            if (lastUsedId is Guid last) w.WriteString("lastUsedID", Database.UuidString(last));
            w.WriteBoolean("askOnLaunch", askOnLaunch);
            w.WriteEndObject();
        }
        return stream.ToArray();
    }

    /// <summary>Null when the file is missing or doesn't decode, as Swift's <c>try?</c> gives.</summary>
    internal static Stored? Load(string path)
    {
        byte[] data;
        try
        {
            data = File.ReadAllBytes(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        return Decode(data);
    }

    /// <summary>
    /// Strict, like Swift's synthesised <c>Decodable</c>: <c>profiles</c> and <c>askOnLaunch</c> are
    /// required, and one bad profile fails the whole file.
    /// </summary>
    internal static Stored? Decode(byte[] data)
    {
        try
        {
            using var document = JsonDocument.Parse(data);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("profiles", out var list) || list.ValueKind != JsonValueKind.Array) return null;
            if (!root.TryGetProperty("askOnLaunch", out var ask) || ask.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
            Guid? lastUsed = null;
            if (root.TryGetProperty("lastUsedID", out var lastElement) && lastElement.ValueKind != JsonValueKind.Null)
            {
                if (Uuid(lastElement) is not Guid last) return null;
                lastUsed = last;
            }
            var profiles = new List<Profile>();
            foreach (var item in list.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) return null;
                if (!item.TryGetProperty("id", out var idElement) || Uuid(idElement) is not Guid id) return null;
                if (!item.TryGetProperty("name", out var nameElement) || nameElement.ValueKind != JsonValueKind.String) return null;
                if (!item.TryGetProperty("createdAt", out var createdElement) || createdElement.ValueKind != JsonValueKind.Number) return null;
                Uri? poster = null;
                if (item.TryGetProperty("lastPosterURL", out var posterElement) && posterElement.ValueKind != JsonValueKind.Null)
                {
                    if (posterElement.ValueKind != JsonValueKind.String) return null;
                    var text = posterElement.GetString()!;
                    if (!Uri.TryCreate(text, UriKind.Absolute, out poster) && !Uri.TryCreate(text, UriKind.RelativeOrAbsolute, out poster)) return null;
                    if (text.Length == 0) return null;
                }
                profiles.Add(new Profile
                {
                    Id = id,
                    Name = nameElement.GetString()!,
                    CreatedAt = StoredDate.FromReference(createdElement.GetDouble()),
                    LastPosterUrl = poster,
                });
            }
            return new Stored(profiles, lastUsed, ask.GetBoolean());
        }
        catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException)
        {
            return null;
        }
    }

    private static Guid? Uuid(JsonElement element) =>
        element.ValueKind == JsonValueKind.String && Guid.TryParseExact(element.GetString(), "D", out var id) ? id : null;
}
