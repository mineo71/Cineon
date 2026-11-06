using System.Collections.Concurrent;
using System.Globalization;
using Cineon.Core.Data;
using Cineon.Core.Tests.Data;
using Cineon.Core.Together;

namespace Cineon.Core.Tests.Together;

/// <summary>One thread that runs everything posted to it, in order: the stand-in for the UI thread.</summary>
internal sealed class SerialContext : SynchronizationContext, IDisposable
{
    private readonly BlockingCollection<(SendOrPostCallback Callback, object? State)> _queue = [];
    private readonly Thread _thread;

    public SerialContext()
    {
        _thread = new Thread(Pump) { IsBackground = true, Name = "Together UI" };
        _thread.Start();
    }

    /// <summary>Exceptions that escaped a posted callback (an unobserved async void, say).</summary>
    public ConcurrentQueue<Exception> Errors { get; } = new();

    private void Pump()
    {
        SetSynchronizationContext(this);
        foreach (var (callback, state) in _queue.GetConsumingEnumerable())
        {
            try
            {
                callback(state);
            }
            catch (Exception e)
            {
                Errors.Enqueue(e);
            }
        }
    }

    public override void Post(SendOrPostCallback d, object? state)
    {
        try
        {
            _queue.Add((d, state));
        }
        catch (InvalidOperationException)
        {
            // Closed: the test is over.
        }
    }

    public override void Send(SendOrPostCallback d, object? state) => Run(() => d(state)).GetAwaiter().GetResult();

    public override SynchronizationContext CreateCopy() => this;

    public Task<T> Run<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(_ =>
        {
            try
            {
                done.SetResult(work());
            }
            catch (Exception e)
            {
                done.SetException(e);
            }
        }, null);
        return done.Task;
    }

    public Task Run(Action work) => Run(() =>
    {
        work();
        return true;
    });

    /// <summary>Lets everything posted so far, and what that posts in turn, run.</summary>
    public async Task Settle()
    {
        for (var i = 0; i < 6; i++)
        {
            await Run(() => { });
            await Task.Delay(3);
        }
    }

    public void Dispose() => _queue.CompleteAdding();
}

/// <summary>A clock that moves only when told, and fires its timers as it passes them.</summary>
internal sealed class ManualClock(DateTimeOffset start) : TimeProvider
{
    private readonly object _lock = new();
    private readonly List<ManualTimer> _timers = [];
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow()
    {
        lock (_lock) return _now;
    }

    public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new ManualTimer(this, callback, state);
        timer.Change(dueTime, period);
        return timer;
    }

    /// <summary>Moves the clock on, firing every timer that comes due on the way, in order.</summary>
    public void Advance(TimeSpan by)
    {
        DateTimeOffset target;
        lock (_lock) target = _now + by;
        while (true)
        {
            ManualTimer? next;
            lock (_lock)
            {
                next = _timers.Where(t => t.Due is { } due && due <= target).MinBy(t => t.Due);
                if (next is null)
                {
                    _now = target;
                    return;
                }
                _now = next.Due!.Value;
                next.Due = next.Period is { } period && period > TimeSpan.Zero ? _now + period : null;
            }
            next.Callback(next.State);
        }
    }

    private sealed class ManualTimer(ManualClock clock, TimerCallback callback, object? state) : ITimer
    {
        public TimerCallback Callback { get; } = callback;
        public object? State { get; } = state;
        public DateTimeOffset? Due { get; set; }
        public TimeSpan? Period { get; set; }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            lock (clock._lock)
            {
                Due = dueTime == Timeout.InfiniteTimeSpan ? null : clock._now + dueTime;
                Period = period == Timeout.InfiniteTimeSpan ? null : period;
                if (!clock._timers.Contains(this)) clock._timers.Add(this);
            }
            return true;
        }

        public void Dispose()
        {
            lock (clock._lock) clock._timers.Remove(this);
        }

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}

internal sealed class FakeHost : ITogetherHost
{
    public AppSettings Settings { get; set; } = new();
    public string PetCode { get; set; } = "p1-Ab3_x9";
    public TogetherRoute Route { get; set; } = TogetherRoute.Other;
    public List<TogetherRoute> Went { get; } = [];
    public List<string> Toasts { get; } = [];
    public string? Clipboard { get; private set; }
    public List<(long TitleId, TitleCard Card)> Applied { get; } = [];
    public List<long> Enriched { get; } = [];
    public int EpisodeCount { get; set; } = 3;

    public void Go(TogetherRoute route)
    {
        Went.Add(route);
        Route = route;
    }

    public void ShowToast(string text) => Toasts.Add(text);

    public void CopyText(string text) => Clipboard = text;

    public void ApplyMetadata(long titleId, TitleCard card) => Applied.Add((titleId, card));

    public void EnrichMetadata(long titleId) => Enriched.Add(titleId);

    public Task<int> EpisodeCountAsync(Title title) => Task.FromResult(EpisodeCount);
}

/// <summary>Tabs with a pretend video that plays on the clock and does what media.js would do with each command.</summary>
internal sealed class FakePlayer(TimeProvider clock) : IPartyPlayer
{
    public sealed class FakeTab(TimeProvider clock)
    {
        private double _position;
        private bool _playing;
        private double _rate = 1;
        private DateTimeOffset _anchor = clock.GetUtcNow();

        public Guid Id { get; } = Guid.NewGuid();
        public Uri? Url { get; set; }
        public bool HasVideo { get; set; } = true;
        public double Duration { get; set; } = 5400;
        /// <summary>Like a page that won't start sound before a click.</summary>
        public bool BlocksAutoplay { get; set; }
        public long? LinkedTitleId { get; set; }
        public TitleCard? Parsed { get; set; }

        public double Position
        {
            get => _playing ? _position + (clock.GetUtcNow() - _anchor).TotalSeconds * _rate : _position;
            set => Reanchor(value);
        }

        public bool Playing
        {
            get => _playing;
            set
            {
                Reanchor(Position);
                _playing = value;
            }
        }

        public double Rate
        {
            get => _rate;
            set
            {
                Reanchor(Position);
                _rate = value;
            }
        }

        private void Reanchor(double position)
        {
            _position = position;
            _anchor = clock.GetUtcNow();
        }
    }

    public Dictionary<Guid, FakeTab> Tabs { get; } = [];
    public Guid? Selected { get; set; }
    public List<(Guid Tab, string Command)> Commands { get; } = [];
    public List<(Guid Tab, string Id, string Text, double Timeout)> Banners { get; } = [];
    public List<(Guid Tab, Uri Url)> Loads { get; } = [];
    public List<(Uri Url, bool Select)> Opened { get; } = [];

    public FakeTab Add(string url, bool select = true)
    {
        var tab = new FakeTab(clock) { Url = new Uri(url) };
        Tabs[tab.Id] = tab;
        if (select) Selected = tab.Id;
        return tab;
    }

    public FakeTab? SelectedFake => Selected is Guid id ? Tabs.GetValueOrDefault(id) : null;

    private static PartyTab Snapshot(FakeTab t) => new(t.Id, t.Url,
        t.HasVideo ? new PartyMedia(t.Position, t.Duration, t.Playing, t.Rate) : null, t.LinkedTitleId, t.Parsed);

    public PartyTab? SelectedTab => SelectedFake is { } t ? Snapshot(t) : null;

    public PartyTab? Tab(Guid id) => Tabs.TryGetValue(id, out var t) ? Snapshot(t) : null;

    public Guid OpenTab(Uri url, bool select)
    {
        Opened.Add((url, select));
        var tab = new FakeTab(clock) { Url = url };
        Tabs[tab.Id] = tab;
        if (select) Selected = tab.Id;
        return tab.Id;
    }

    public void Load(Guid tab, Uri url)
    {
        Loads.Add((tab, url));
        if (Tabs.TryGetValue(tab, out var t)) t.Url = url;
    }

    public Task<string?> EvaluateInPlayerAsync(Guid tab, string script)
    {
        Assert.Equal(TogetherModel.PlayerStateScript, script);
        if (!Tabs.TryGetValue(tab, out var t) || !t.HasVideo) return Task.FromResult<string?>("null");
        var json = string.Create(CultureInfo.InvariantCulture,
            $"{{\"type\":\"tick\",\"t\":{t.Position:R},\"d\":{t.Duration:R},\"paused\":{(t.Playing ? "false" : "true")},\"muted\":false,\"rate\":{t.Rate:R}}}");
        return Task.FromResult<string?>(json);
    }

    public void PlayerCommand(Guid tab, string command)
    {
        Commands.Add((tab, command));
        if (!Tabs.TryGetValue(tab, out var t)) return;
        if (command == "play()" && !t.BlocksAutoplay) t.Playing = true;
        else if (command == "pause()") t.Playing = false;
        else if (command.StartsWith("seek(", StringComparison.Ordinal)) t.Position = double.Parse(command[5..^1], CultureInfo.InvariantCulture);
        else if (command.StartsWith("rate(", StringComparison.Ordinal)) t.Rate = double.Parse(command[5..^1], CultureInfo.InvariantCulture);
    }

    public void ShowBanner(Guid tab, string id, string text, double timeout) => Banners.Add((tab, id, text, timeout));
}

/// <summary>One person's connection to the shared fake server, which can drop.</summary>
internal sealed class Connection(HttpMessageHandler server) : DelegatingHandler(server)
{
    public bool Offline { get; set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        Offline ? throw new HttpRequestException("The network connection was lost.") : base.SendAsync(request, cancellationToken);
}

/// <summary>A person with a profile, a library, the app around them and a TogetherModel on the shared server.</summary>
internal sealed class TestPerson : IDisposable
{
    private readonly TempFolder _folder = new();

    public TestPerson(TogetherRig rig, string name, bool withServer = true)
    {
        Rig = rig;
        Profile = new Cineon.Core.Data.Profile { Id = Guid.NewGuid(), Name = name, CreatedAt = rig.Clock.GetUtcNow() };
        Db = new Database(_folder.File("cineon.sqlite"));
        Library = new LibraryStore(Db);
        Player = new FakePlayer(rig.Clock);
        Connection = new Connection(rig.Server);
        Client = withServer ? new TogetherClient(new Uri("https://fake-deployment.convex.cloud"), new HttpClient(Connection, disposeHandler: false)) : null;
        Model = new TogetherModel(Profile, Library, Host, Player, Client, rig.Context, rig.Clock);
    }

    public TogetherRig Rig { get; }
    public Cineon.Core.Data.Profile Profile { get; }
    public Database Db { get; }
    public LibraryStore Library { get; }
    public FakeHost Host { get; } = new();
    public FakePlayer Player { get; }
    public Connection Connection { get; }
    public TogetherClient? Client { get; }
    public TogetherModel Model { get; private set; }

    public string IdentityFile => TogetherIdentity.FileFor(Profile.Id);

    /// <summary>Runs on the UI thread, where the library and the fakes live.</summary>
    public Task<T> Ui<T>(Func<T> work) => Rig.Context.Run(work);

    public Task Ui(Action work) => Rig.Context.Run(work);

    /// <summary>The model as it would be after quitting and opening Cineon again.</summary>
    public TogetherModel Restart()
    {
        Rig.Context.Run(Model.Stop).Wait(2000);
        Model = new TogetherModel(Profile, Library, Host, Player, Client, Rig.Context, Rig.Clock);
        return Model;
    }

    public void Dispose()
    {
        Rig.Context.Run(Model.Stop).Wait(2000);
        Db.Dispose();
        _folder.Dispose();
    }
}

internal sealed class TogetherRig : IDisposable
{
    private readonly List<TestPerson> _people = [];

    public TogetherRig()
    {
        Clock = new ManualClock(new DateTimeOffset(2026, 11, 6, 20, 0, 0, TimeSpan.Zero));
        Server = new FakeConvex(Clock);
    }

    public ManualClock Clock { get; }
    public FakeConvex Server { get; }
    public SerialContext Context { get; } = new();

    public TestPerson Person(string name, bool withServer = true)
    {
        var person = new TestPerson(this, name, withServer);
        _people.Add(person);
        return person;
    }

    /// <summary>Moves the clock (and the server's) on, then lets whatever the timers started finish.</summary>
    public async Task Advance(double seconds)
    {
        await Context.Run(() => Clock.Advance(TimeSpan.FromSeconds(seconds)));
        await Context.Settle();
    }

    /// <summary>Moves on a step at a time until <paramref name="condition"/> holds.</summary>
    public async Task AdvanceUntil(Func<bool> condition, string what, double step = 1, int steps = 20)
    {
        for (var i = 0; i < steps; i++)
        {
            if (await Context.Run(condition)) return;
            await Advance(step);
        }
        if (!await Context.Run(condition)) throw new TimeoutException("Never happened: " + what);
    }

    public async Task WaitUntil(Func<bool> condition, string what, int timeoutMs = 5000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!await Context.Run(condition))
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("Timed out waiting for " + what);
            await Task.Delay(10);
        }
    }

    public void Dispose()
    {
        foreach (var person in _people) person.Dispose();
        Context.Settle().Wait(2000);
        var errors = Context.Errors.ToList();
        Context.Dispose();
        Server.Dispose();
        Assert.Empty(errors);
    }
}
