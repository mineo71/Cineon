#!/usr/bin/env python3
"""End-to-end test on Windows: drives a real Debug build of Cineon against the fake streaming site.

    python fixtures/e2e_windows.py

The Windows twin of fixtures/e2e.py, with the same sections and checks. The Mac drives its app
through `cineon://debug/...` links and a reply file; this talks to the same commands over the app's
local test port (DebugCommands.cs: `GET http://127.0.0.1:$CINEON_DEBUG_PORT/<command>?<query>`), and
clicks with real Windows input (SendInput) where the Mac uses CGEvents.

Sections that only talk through debug commands and the database run straight from e2e.py with the
transport swapped underneath them, so a check changed there changes here too. The few that touch
the OS (the main walk-through's search link and Downloads folder, frames, downloads, the window's
bar) are Windows versions below.

Uses a throwaway data folder, so real libraries are never touched. Needs node, ffmpeg and ffprobe
on PATH and fixtures/film.mp4, short.mp4 and hls/ made as the Makefile does. Takes 15-30 minutes.

    CINEON_E2E_ONLY=autopilot,rescue   runs just those sections (main, chrome and memory too)
    CINEON_E2E_EXE=...                 another build of Cineon.exe
    CINEON_DEBUG_PORT=8790             the app's test port
    CINEON_E2E_SLOW=1.5                stretches every wait_until timeout (CI machines are slow)
    CINEON_E2E_BUDGET=70               minutes before the remaining sections are skipped
    CINEON_E2E_ARTIFACTS=dir           where the log, crash.log and screenshots of failures go
    CINEON_E2E_KEEP=1                  leaves the app open afterwards
"""
import glob
import http.client
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

if sys.platform != "win32" and not os.environ.get("CINEON_E2E_ANY_OS"):
    sys.exit("This is the Windows end-to-end test. On a Mac, run fixtures/e2e.py (make e2e).")

# Film names are Ukrainian and Russian, and Windows consoles and pipes default to a code page.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

ROOT = Path(__file__).resolve().parent.parent
EXE = Path(os.environ.get("CINEON_E2E_EXE") or ROOT / "windows/Cineon.App/bin/Debug/net10.0-windows10.0.19041.0/win-x64/Cineon.exe")
DEBUG_PORT = int(os.environ.get("CINEON_DEBUG_PORT") or 8790)
DATA = Path(os.environ.get("CINEON_E2E_DATA") or tempfile.mkdtemp(prefix="cineon-e2e-")).resolve()
FAKE_BROWSERS = Path(os.environ.get("CINEON_E2E_BROWSERS") or tempfile.mkdtemp(prefix="cineon-e2e-browsers-")).resolve()
ARTIFACTS = Path(os.environ.get("CINEON_E2E_ARTIFACTS") or DATA / "e2e-artifacts").resolve()
SLOW = float(os.environ.get("CINEON_E2E_SLOW") or 1.5)
BUDGET_SECONDS = float(os.environ.get("CINEON_E2E_BUDGET") or 70) * 60

DATA.mkdir(parents=True, exist_ok=True)
FAKE_BROWSERS.mkdir(parents=True, exist_ok=True)
ARTIFACTS.mkdir(parents=True, exist_ok=True)

# e2e.py reads these when it's imported: its DATA is this run's folder.
os.environ["CINEON_E2E_DATA"] = str(DATA)
os.environ["CINEON_E2E_BROWSERS"] = str(FAKE_BROWSERS)
sys.path.insert(0, str(ROOT / "fixtures"))
import e2e as mac  # noqa: E402  (the Mac's test, for its shared sections and helpers)

PORT = mac.PORT
BASE = mac.BASE
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never through a proxy

results = []
current_section = ["startup"]
section_failures = {}
started_at = time.time()
log_file = open(ARTIFACTS / "e2e-windows.log", "w", encoding="utf-8")


def say(text=""):
    print(text, flush=True)
    log_file.write(text + "\n")
    log_file.flush()


# MARK: The app

app_process = None
app_launches = 0
gave_up = [False]
server_process = None


def app_env():
    env = dict(os.environ)
    for key in ("CINEON_ROUTE", "CINEON_THEME", "CINEON_E2E_DATA", "CINEON_E2E_BROWSERS"):
        env.pop(key, None)
    env["CINEON_DATA_DIR"] = str(DATA)
    env["CINEON_DEBUG_PORT"] = str(DEBUG_PORT)
    env["CINEON_IMPORT_ROOT"] = str(FAKE_BROWSERS)
    return env


def launch_app():
    global app_process, app_launches
    app_launches += 1
    app_process = subprocess.Popen([str(EXE)], env=app_env(), cwd=str(EXE.parent))
    if not wait_ready(timeout=120):
        raise RuntimeError(f"Cineon didn't answer on port {DEBUG_PORT} within two minutes.\n{crash_log_tail()}")


def wait_ready(timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if app_process is not None and app_process.poll() is not None:
            return False
        try:
            if request("ping", 3) == "pong":
                return True
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.5)
    return False


def app_alive():
    return app_process is not None and app_process.poll() is None


def crash_log_tail(lines=40):
    path = DATA / "crash.log"
    if not path.exists():
        return "(no crash.log)"
    text = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "crash.log:\n    " + "\n    ".join(text[-lines:])


def ensure_app():
    """Starts Cineon again if it died, and says so loudly: a crash is a failure in itself."""
    if app_alive():
        return
    if gave_up[0]:
        raise RuntimeError("Cineon isn't running (gave up starting it again)")
    code = app_process.poll() if app_process is not None else None
    record(f"Cineon kept running during '{current_section[0]}'", False, f"exit code {code}\n{crash_log_tail()}")
    if app_launches > 6:
        gave_up[0] = True
        raise RuntimeError("Cineon keeps dying; giving up")
    say("  !!  Cineon is gone; starting it again on the same data")
    launch_app()


def kill_tree(pid):
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)


def kill_strays():
    """Copies of this build and fixture servers left from an earlier run. Only this build: an
    installed Cineon is never touched."""
    exe = str(EXE).replace("'", "''")
    script = (
        f"Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -eq '{exe}' -or "
        f"($_.Name -eq 'node.exe' -and $_.CommandLine -like '*fixtures*server.js*') }} | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True)


def quit_app():
    if not app_alive():
        return
    try:
        request("quit", 10)
    except (OSError, http.client.HTTPException):
        pass
    for _ in range(30):
        if not app_alive():
            return
        time.sleep(0.5)
    kill_tree(app_process.pid)


# MARK: Transport, replacing e2e.py's links and reply file

def request(path, timeout, **params):
    url = f"http://127.0.0.1:{DEBUG_PORT}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    req = urllib.request.Request(url, headers={"X-Cineon-Debug": "1"})
    with LOCAL.open(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def debug(path, _timeout=90, **params):
    """Runs a test command on the app's UI thread and returns its reply. The Mac's version only
    sends the link; this one waits for the command to finish, which the checks don't mind."""
    last = None
    for _ in range(3):
        ensure_app()
        try:
            return request(path, _timeout, **params)
        except (socket.timeout, TimeoutError) as error:
            # Sent, but slow: running it again could do it twice.
            say(f"  !!  /{path} timed out after {_timeout}s: {error}")
            return ""
        except (urllib.error.URLError, ConnectionError, http.client.HTTPException, OSError) as error:
            last = error
            time.sleep(1)
    say(f"  !!  /{path} got no reply: {last}")
    return ""


def state():
    text = ""
    for _ in range(5):
        text = debug("state", _timeout=30)
        if "profile=" in text and "memory=" in text:
            out = {}
            for line in text.splitlines():
                key, _, value = line.partition("=")
                out[key] = value
            return out
        time.sleep(0.5)
    raise RuntimeError("no state from app. It said: " + repr(text[:400]))


def evaluate(js, world="page"):
    return debug("eval", js=js, world=world)


def media_eval(js):
    return debug("mediaeval", js=js)


def read_debug(path, _wait=6, **params):
    """A command whose reply ends with end=1. Commands that talk to a server need a longer `_wait`."""
    text = debug(path, _timeout=max(30, _wait * 3), **params)
    return text if text.endswith("end=1") else ""


def wait_until(predicate, timeout=15, every=0.3):
    deadline = time.time() + timeout * SLOW
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(every)
    return None


def db():
    profile = state()["profileid"]
    path = DATA / "Profiles" / profile / "cineon.sqlite"
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)


def query(sql, *args):
    last = None
    for _ in range(8):
        try:
            conn = db()
            try:
                return conn.execute(sql, args).fetchall()
            finally:
                conn.close()
        except sqlite3.OperationalError as error:
            # The app may be writing, or its first write may not have made the file yet.
            last = error
            time.sleep(0.4)
    raise last


def fetch(path):
    LOCAL.open(BASE + path, timeout=30).read()


def restart_app():
    """Kills the test build the hard way, as a crash would, and starts it again on the same data."""
    if app_process is not None:
        kill_tree(app_process.pid)
        wait_until(lambda: not app_alive(), timeout=10)
    time.sleep(2)
    try:
        launch_app()
    except RuntimeError as error:
        say(f"  !!  {error}")
        return None
    time.sleep(4)
    return wait_until(lambda: (lambda st: st if st.get("profile") else None)(state_or_none()), timeout=20)


def state_or_none():
    try:
        return state()
    except RuntimeError:
        return None


# Whether this run reads staying awake from Windows itself (powercfg) or from the app's own report.
awake_mode = ["os"]
awake_mismatches = [0]


def powercfg_holds_display():
    """True or False from `powercfg /requests` (needs an administrator), or None when it can't tell."""
    try:
        out = subprocess.run(["powercfg", "/requests"], capture_output=True, text=True, errors="replace", timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0 or "DISPLAY:" not in out.stdout:
        return None
    section = ""
    for line in out.stdout.splitlines():
        stripped = line.strip()
        if stripped.endswith(":") and stripped[:-1].isupper():
            section = stripped[:-1]
        elif section == "DISPLAY" and EXE.name.lower() in stripped.lower():
            return True
    return False


def keeps_awake():
    """Whether this build is keeping the display on right now: the Mac's pmset check, through
    powercfg. If powercfg can't be read, or never lists the request the app says it holds
    (SetThreadExecutionState doesn't show on every Windows), the app's own report is used."""
    app_says = state().get("awake") == "true"
    if awake_mode[0] == "app":
        return app_says
    os_says = powercfg_holds_display()
    if os_says is None:
        awake_mode[0] = "app"
        say("    (powercfg /requests can't be read here: staying awake is read from the app's report)")
        return app_says
    if app_says and not os_says:
        awake_mismatches[0] += 1
        if awake_mismatches[0] >= 6:
            awake_mode[0] = "app"
            say("    (powercfg never lists the app's display request: staying awake is read from the app's report)")
            return app_says
    return os_says


def convex(kind, path, **args):
    """Calls the Together server the way a friend's Cineon would. urllib, not curl: Windows' curl
    gets arguments in the ANSI code page, which loses the emoji."""
    body = json.dumps({"path": path, "args": args, "format": "json"}).encode("utf-8")
    req = urllib.request.Request(f"{mac.TOGETHER}/api/{kind}", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as response:
        reply = json.loads(response.read().decode("utf-8"))
    if reply.get("status") != "success":
        raise RuntimeError(reply.get("errorMessage"))
    return reply.get("value")


# MARK: Checks

# The Mac's sections name Mac things. The checks are the same.
RENAMES = [
    ("Control Center shows", "The media flyout shows"),
    ("Siri's play or pause", "The Jump List's Play or Pause"),
    ("the Mac", "the PC"),
    ("this Mac", "this PC"),
    ("This Mac", "This PC"),
]

STATE_KEYS = ["profile", "route", "url", "parsed", "media", "track", "blocked", "banner", "rescue", "failure", "toast",
              "tabs", "tablist", "search", "windowVisible", "appActive", "awake", "ambient", "hibernated", "ready", "best"]


def record(name, ok, detail=""):
    results.append((current_section[0], name, bool(ok), detail))
    mark = "PASS" if ok else "FAIL"
    say(f"  {mark}  {name}" + (f"   [{detail}]" if detail and not ok else ""))
    if not ok:
        section_failures[current_section[0]] = section_failures.get(current_section[0], 0) + 1


def check(name, ok, detail=""):
    for mac_words, windows_words in RENAMES:
        name = name.replace(mac_words, windows_words)
    record(name, ok, detail)
    if not ok:
        # What the app looked like at the moment, to read on a build machine nobody watches.
        try:
            st = state()
            say("        state: " + "  ".join(f"{k}={st.get(k, '?')}" for k in STATE_KEYS))
        except Exception as error:  # noqa: BLE001  (a dead app is reported by ensure_app)
            say(f"        state: unavailable ({error})")


# The Mac's sections call these through e2e.py's globals, so they run on Windows unchanged.
mac.debug = debug
mac.state = state
mac.evaluate = evaluate
mac.media_eval = media_eval
mac.read_debug = read_debug
mac.wait_until = wait_until
mac.db = db
mac.query = query
mac.fetch = fetch
mac.restart_app = restart_app
mac.state_or_none = state_or_none
mac.keeps_awake = keeps_awake
mac.convex = convex
mac.check = check
# e2e.py's sections print their headings and skips themselves: into this run's log too.
mac.print = lambda *args, **kwargs: say(" ".join(str(a) for a in args))

# Shorter names for the Windows sections below.
click = mac.click
open_page = mac.open_page
play_muted = mac.play_muted
fresh_profile = mac.fresh_profile
start_playing = mac.start_playing
media_position = mac.media_position
fields_of = mac.fields_of
downloads_list = mac.downloads_list
wait_download = mac.wait_download
frame_files = mac.frame_files
is_real_picture = mac.is_real_picture


def screenshot(name):
    """The whole screen, for a section that failed."""
    path = ARTIFACTS / f"{name}.png"
    script = (
        "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; "
        "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; "
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; "
        "[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); "
        f"$bmp.Save('{str(path)}')"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, timeout=30)


def image_size(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0:s=x", str(path)], capture_output=True, text=True, errors="replace").stdout.strip()
    try:
        width, height = (int(n) for n in out.splitlines()[0].split("x"))
        return width, height
    except (ValueError, IndexError):
        return 0, 0


def same_folder(path, folder):
    return os.path.normcase(os.path.abspath(str(path))).startswith(os.path.normcase(os.path.abspath(str(folder))))


def make_fake_browsers(root):
    """The Mac's fake Arc (its folder layout works here too), plus a Chrome and an Edge in the
    folders they use on Windows."""
    mac.make_fake_browsers(root)
    now = int((time.time() + 11644473600) * 1_000_000)
    day = 86400 * 1_000_000
    windows_browsers = {
        "Google/Chrome/User Data/Default": [
            ("https://kinogo.example/film/heat-1995.html", "Схватка / Heat (1995) смотреть онлайн", 3, now - 30 * day),
            ("https://news.example/2025/other", "Another news story", 1, now - 2 * day),
        ],
        "Microsoft/Edge/User Data/Default": [
            ("https://flixdemo.example/watch/arrival-77", "Watch Arrival (2016) Full Movie Online Free | FlixDemo", 2, now - 50 * day),
        ],
    }
    for folder, rows in windows_browsers.items():
        profile = root / folder
        profile.mkdir(parents=True, exist_ok=True)
        db_file = profile / "History"
        if db_file.exists():
            db_file.unlink()
        conn = sqlite3.connect(db_file)
        conn.execute("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)")
        conn.executemany("INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time) VALUES(?,?,?,0,?)", rows)
        conn.commit()
        conn.close()


# MARK: Sections

def main_tests():
    """The Mac's run_tests from the film page to the import, with a Windows search link,
    Downloads folder and import roots."""
    print_section("Film page: messy title, cross-origin player, ad traps")
    open_page("/watch/dune-part-two-2024")
    s = state()
    check("title recognised without page furniture", s["parsed"].startswith("Dune: Part Two|2024"), s["parsed"])
    check("kind recognised as film", "|film|" in s["parsed"], s["parsed"])

    ad_loaded = evaluate("document.getElementById('adimg').naturalWidth")
    check("ad image on popads.net was blocked", ad_loaded.strip() == "0", ad_loaded)
    hidden = evaluate("getComputedStyle(document.getElementById('cosmetic')).display")
    check("cosmetic rule hid the ad box", hidden.strip() == "none", hidden)
    s = wait_until(lambda: (lambda st: st if "ads: 0" not in st["blocked"] else None)(state()), timeout=5)
    check("blocked ads are counted", s, state()["blocked"])

    # First real click lands on the invisible layer over the page.
    click(700, 300)
    time.sleep(1)
    trap_gone = evaluate("document.getElementById('x8f3k') === null")
    check("click trap removed by the sweeper", trap_gone.strip() == "1", trap_gone)
    fired = evaluate("String(window.__trapFired)")
    check("trap's own click handler never ran", fired.strip() == "undefined", fired)

    # Real click on the page body, which tries to open a pop-up from a document handler.
    click(500, 20)
    time.sleep(1)
    s = state()
    check("pop-up was blocked, no new tab", s["tabs"] == "1" and "popups: 0" not in s["blocked"], f'{s["tabs"]} {s["blocked"]}')

    print_section("Tracking playback")
    play_muted()
    s = wait_until(lambda: (lambda st: st if st["media"] != "-" and "playing=true" in st["media"] else None)(state()), timeout=8)
    check("video in cross-origin iframe detected and playing", s, state()["media"])
    rows = wait_until(lambda: query("SELECT t.name,t.year,t.status,s.host FROM sessions s JOIN titles t ON t.id=s.title_id"), timeout=20)
    check("session recorded on the timeline", rows, str(rows))
    if rows:
        check("session names the right film", rows[0][0].startswith("Dune"), str(rows[0]))
        check("title moved to watching", rows[0][2] == "watching", str(rows[0]))
        check("session records the site", rows[0][3] == "127.0.0.1", str(rows[0]))

    media_eval("document.querySelector('video').currentTime = 300; true")
    time.sleep(1)
    media_eval("var v=document.querySelector('video'); v.play(); true")
    saved = wait_until(lambda: (lambda r: r if r and r[0][0] > 295 else None)(query("SELECT position,duration,url FROM progress")), timeout=16)
    check("position is saved while watching", saved, str(query("SELECT position,duration FROM progress")))

    # Ambient light from the video's own frames.
    z = wait_until(lambda: (lambda st: st if st["ambient"].split()[0] not in ("0.0", "0") and "r: 0.0, g: 0.0, b: 0.0" not in st["ambient"] else None)(state()), timeout=10)
    amb = state()
    if amb.get("windowVisible") == "false":
        say("  SKIP  ambient light: the window is minimised or hidden, and ambient pauses when it can't be seen")
    else:
        check("ambient light is reading colour from the film", z, " ".join(f"{k}={amb.get(k)}" for k in ["ambient", "route", "media", "windowVisible", "appActive", "ambientOn", "url"]))

    print_section("Video whose frames can't be read")
    open_page("/tainted")
    time.sleep(0.8)
    media_eval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.muted=true; v.play(); true")
    tainted = wait_until(lambda: state()["framesBlocked"] == "true", timeout=8)
    check("cross-origin video falls back without errors", tainted, state()["framesBlocked"])
    time.sleep(7)
    say("    fallback ambient: " + state()["ambient"])
    debug("closetab")
    time.sleep(0.5)

    print_section("Resume across a reload of the page")
    progress = query("SELECT position FROM progress")
    pos_before = progress[0][0] if progress else 0
    debug("closetab")
    time.sleep(1)
    s = state()
    check("closing the tab leaves none open", s["tabs"] == "0", s["tabs"])
    open_page("/watch/dune-part-two-2024")
    resumed = wait_until(lambda: (lambda m: m if m != "-" else None)(state()["media"]), timeout=10) or "-"
    position = float(resumed.split("/")[0]) if resumed != "-" else 0
    check("video resumed at the saved place", position > pos_before - 15, f"{position} vs {pos_before}")

    print_section("Finishing a film")
    media_eval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.muted=true; v.currentTime = v.duration * 0.95; v.play(); true")
    status = wait_until(lambda: (lambda r: r if r and r[0][0] == "watched" else None)(query("SELECT status FROM titles WHERE name LIKE 'Dune%'")), timeout=25)
    check("film moves to watched at 92 percent", status, str(query("SELECT name,status FROM titles")))

    print_section("Ukrainian series page")
    open_page("/serial/rozryv/2-sezon/4-seriya")
    s = state()
    check("Ukrainian title cleaned", s["parsed"].startswith("Розрив|"), s["parsed"])
    check("season and episode read from Ukrainian", "S2E4" in s["parsed"], s["parsed"])
    check("kind recognised as series", "|series|" in s["parsed"], s["parsed"])
    play_muted()
    rows = wait_until(lambda: query("SELECT season,episode FROM sessions WHERE season=2 AND episode=4"), timeout=20)
    check("episode recorded on the timeline", rows, str(query("SELECT title_id,season,episode FROM sessions")))
    debug("mediaeval", js="document.querySelector('video').pause(); true")
    time.sleep(0.5)

    print_section("Structured data page")
    open_page("/tv/the-bear/episode")
    s = state()
    check("JSON-LD series name wins over page title", s["parsed"].startswith("The Bear|"), s["parsed"])
    check("JSON-LD season and episode", "S2E7" in s["parsed"], s["parsed"])

    print_section("Video inside nested web components")
    open_page("/shadow")
    time.sleep(1)
    debug("eval", js="window.__deep=document.querySelector('shadow-outer').shadowRoot.querySelector('shadow-inner').shadowRoot.querySelector('video'); window.__deep.muted=true; window.__deep.play(); window.dispatchEvent(new Event('pointerdown')); 1")
    seen = wait_until(lambda: "playing=true" in state()["media"], timeout=12)
    check("video two shadow roots deep is detected", seen, state()["media"])
    debug("eval", js="window.__deep.pause(); 1")
    time.sleep(0.5)

    print_section("Episode kept only in the address fragment")
    debug("open", url=BASE + "/series/drama/1-mentalist-2008.html#t:238-s:3-e:5")
    wait_until(lambda: state().get("parsed", "-") != "-", timeout=8)
    time.sleep(1)
    s = state()
    check("dub removed from the name", s["parsed"].startswith("Менталист|"), s["parsed"])
    check("episode read from the fragment", "S3E5" in s["parsed"], s["parsed"])
    media_eval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.muted=true; v.play(); true")
    first = wait_until(lambda: query("SELECT season,episode FROM sessions WHERE season=3 AND episode=5"), timeout=15)
    check("first episode recorded", first, str(query("SELECT season,episode FROM sessions")))
    evaluate("location.hash='#t:238-s:3-e:6'; 1")
    time.sleep(1.5)
    check("changing the fragment moves to the next episode", "S3E6" in state()["parsed"], state()["parsed"])
    media_eval("var v=document.querySelector('video'); v.currentTime=60; v.play(); true")
    second = wait_until(lambda: query("SELECT season,episode FROM sessions WHERE season=3 AND episode=6"), timeout=15)
    check("second episode gets its own timeline entry", second, str(query("SELECT season,episode FROM sessions")))
    media_eval("document.querySelector('video').pause(); true")
    time.sleep(0.5)

    print_section("Short clip")
    before = query("SELECT count(*) FROM sessions")[0][0]
    open_page("/clip")
    play_muted()
    time.sleep(7)
    after = query("SELECT count(*) FROM sessions")[0][0]
    check("a 30-second clip is not tracked", before == after, f"{before} to {after}")

    print_section("Turning shields off for one site")
    debug("sitepref", host="127.0.0.1", shieldsOff="1")
    open_page("/watch/dune-part-two-2024")
    time.sleep(1)
    s = state()
    check("no ads are blocked on a site with shields off", "ads: 0" in s["blocked"], s["blocked"])
    shown = evaluate("getComputedStyle(document.getElementById('cosmetic')).display")
    check("cosmetic rules are off there too", shown.strip() != "none", shown)
    debug("sitepref", host="127.0.0.1", shieldsOff="0")
    time.sleep(0.3)
    open_page("/watch/dune-part-two-2024")
    back_on = wait_until(lambda: "ads: 0" not in state()["blocked"], timeout=5)
    check("blocking returns when shields go back on", back_on, state()["blocked"])

    print_section("Sites that aren't about films")
    debug("sitepref", host="127.0.0.1", trackingOff="1")
    before = query("SELECT count(*) FROM sessions")[0][0]
    open_page("/shadow")
    time.sleep(1)
    debug("eval", js="window.__deep=document.querySelector('shadow-outer').shadowRoot.querySelector('shadow-inner').shadowRoot.querySelector('video'); window.__deep.muted=true; window.__deep.play(); window.dispatchEvent(new Event('pointerdown')); 1")
    time.sleep(8)
    check("a site with tracking off adds nothing to the timeline", query("SELECT count(*) FROM sessions")[0][0] == before)
    debug("eval", js="window.__deep.pause(); 1")
    debug("sitepref", host="127.0.0.1", trackingOff="0")
    time.sleep(0.5)

    print_section("Silent autoplay banner")
    before = query("SELECT count(*) FROM sessions")[0][0]
    open_page("/hero")
    time.sleep(8)
    playing = evaluate("!document.getElementById('v').paused")
    check("the banner really is playing", playing.strip() == "1", playing)
    after = query("SELECT count(*) FROM sessions")[0][0]
    check("a silent autoplay banner is not tracked", before == after, f"{before} to {after}")

    print_section("Hostile navigation")
    open_page("/redirector")
    time.sleep(1.5)
    s = state()
    check("scripted redirect blocked", s["url"].endswith("/redirector"), s["url"])
    check("redirect counted", "redirects: 0" not in s["blocked"], s["blocked"])

    downloads_folder = Path.home() / "Downloads"
    before_files = set(os.listdir(downloads_folder)) if downloads_folder.exists() else set()
    open_page("/download-trap")
    time.sleep(1.5)
    after_files = set(os.listdir(downloads_folder)) if downloads_folder.exists() else set()
    check("fake download blocked", not any(name.startswith("player-update") for name in after_files - before_files), str(after_files - before_files))

    print_section("Legitimate navigation still works")
    open_page("/same-site")
    click(20, 10)
    time.sleep(0.2)
    evaluate("document.getElementById('next').click(); 1")
    moved = wait_until(lambda: state()["url"].endswith("/same-site-2"), timeout=5)
    check("same-site link works with shields on", moved, state()["url"])

    open_page("/same-site")
    check("a new tab has nothing to go back to", state()["canGoBack"] == "false", state()["canGoBack"])
    tabs_before = int(state()["tabs"])
    rect = evaluate("(()=>{const r=document.getElementById('blank').getBoundingClientRect();return Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2)})()")
    try:
        x, y = rect.strip().split(",")
    except ValueError:
        x, y = "0", "0"
    click(x, y)
    opened = wait_until(lambda: int(state()["tabs"]) == tabs_before + 1, timeout=5)
    check("real click on a same-site new-tab link opens a tab", opened, f'{state()["tabs"]} {state()["toast"]}')

    print_section("Search everywhere")
    debug("addsite", url=BASE + "/", name="FlixDemo", search=BASE + "/search?q=%s")
    debug("addsite", url="http://localhost:%d/" % PORT, name="LocalDemo")
    time.sleep(0.5)
    # A second launch with a link, as the shell starts it: the running copy (same data folder) takes it.
    link = "cineon://search?q=" + urllib.parse.quote("dune part")
    second = subprocess.Popen([str(EXE), link], env=app_env(), cwd=str(EXE.parent))
    try:
        handed_over = second.wait(timeout=45) is not None
    except subprocess.TimeoutExpired:
        handed_over = False
        kill_tree(second.pid)
    check("a second launch hands its link to the running copy and quits", handed_over)
    s = wait_until(lambda: (lambda st: st if "/search?q=dune" in st["search"] else None)(state()), timeout=8)
    check("search opens on sites with search set up", s, state()["search"])
    if not s:
        # So the checks after it still have a search to work on.
        debug("link", url=link)
        wait_until(lambda: "/search?q=dune" in state()["search"], timeout=5)
    debug("searchselect", host="127.0.0.1")
    time.sleep(0.5)
    found = wait_until(lambda: "Results for dune part" in evaluate("document.getElementById('result') && document.getElementById('result').textContent"), timeout=8)
    check("site search page loaded with the query", found)
    tabs_during = int(state()["tabs"])
    debug("eval", js="location.href='/same-site-2'; 1", world="page")
    time.sleep(1)
    debug("route", to="home")
    time.sleep(0.5)
    listed = state()["tablist"]
    check("a clicked-through search result survives as a tab", "/same-site-2" in listed, listed)
    check("untouched search results are cleaned up", "/search?q=" not in listed and int(state()["tabs"]) < tabs_during, listed)

    print_section("Learning search from a page")
    debug("open", url=f"http://localhost:{PORT}/")
    learned = wait_until(lambda: "localhost|http://localhost:%d/search?q=%%s" % PORT in state()["sites"], timeout=8)
    check("search address learned from the site's form", learned, state()["sites"])

    print_section("Hibernation")
    open_page("/same-site")
    debug("hibernate")
    time.sleep(0.5)
    s = state()
    check("idle tabs release their web view", "[h]" in s["tablist"], s["tablist"])
    debug("selecttab", i=0)
    time.sleep(1.5)
    s = state()
    check("tab wakes up on selection", s["url"] != "-" and "[h]" not in s["tablist"].split(",")[0], s["tablist"])

    print_section("Profiles")
    open_page("/same-site")
    evaluate("document.cookie='who=first; path=/'; 1")
    titles_before = query("SELECT count(*) FROM titles")[0][0]
    debug("addprofile", name="Guest", switch="1")
    switched = wait_until(lambda: state()["profile"] == "Guest", timeout=6)
    check("switched to a new profile", switched, state()["profile"])
    time.sleep(1)
    guest_files = glob.glob(str(DATA / "Profiles/*/cineon.sqlite"))
    check("each profile has its own database", len(guest_files) == 2, str(guest_files))
    guest = wait_until(lambda: query("SELECT count(*) FROM titles")[0][0] == 0, timeout=4)
    check("new profile starts with an empty library", guest, f"first had {titles_before}")
    open_page("/same-site")
    cookie = evaluate("document.cookie")
    check("cookies don't leak between profiles", "who=first" not in cookie, cookie)
    debug("switchprofile", name=json.loads((DATA / "profiles.json").read_text(encoding="utf-8"))["profiles"][0]["name"])
    back = wait_until(lambda: state()["profile"] != "Guest", timeout=6)
    check("switching back works", back)
    time.sleep(1)
    check("first profile's library is intact", query("SELECT count(*) FROM titles")[0][0] == titles_before)

    print_section("Import from another browser")
    debug("switchprofile", name="Guest")
    wait_until(lambda: state()["profile"] == "Guest", timeout=6)
    time.sleep(1)
    report = debug("importreport", _timeout=120, apply="Arc")
    check("the fake Arc is found and read", "browser=Arc" in report and "applied" in report, report)
    check("Chrome and Edge in their Windows folders are found too", "browser=Chrome" in report and "browser=Edge" in report, report)
    names = [r[0] for r in query("SELECT name FROM titles")]
    # Names may already have been replaced by their catalogue name, so look for either form.
    check("films are found in the history", any(n in ("Дюна", "Dune") for n in names), str(names))
    check("everyday pages are left out", not any("shoes" in n.lower() or "news" in n.lower() for n in names), str(names))
    series = query("SELECT season,episode FROM progress WHERE season=2 AND episode=4")
    check("a series keeps the episode you ended on", series, str(query("SELECT season,episode FROM progress")))
    sites = [r[0] for r in query("SELECT host FROM sites")]
    check("film sites are added to the grid", "uakino.example" in sites and "kinoteka.example" in sites, str(sites))
    check("visited pages are searchable", query("SELECT count(*) FROM history WHERE title LIKE '%shoes%'")[0][0] == 1)
    timeline = query("SELECT count(*) FROM sessions WHERE duration=0")[0][0]
    check("imported films appear on the timeline", timeline >= 5, str(timeline))
    debug("importreport", _timeout=120, apply="Arc")
    time.sleep(2)
    again = query("SELECT count(*) FROM sessions WHERE duration=0")[0][0]
    check("importing twice adds nothing", again == timeline, f"{timeline} to {again}")


def frame_tests():
    """e2e.py's frame_tests, measuring the picture with ffprobe instead of sips."""
    print_section("Frames: video the page can read")
    fresh_profile("Frames")
    open_page("/tv/the-bear/episode")
    start_playing(120)
    first = wait_until(lambda: query("SELECT position,is_moment,file FROM frames"), timeout=50)
    s = state()
    detail = f'media={s["media"]} track={s["track"]} visible={s["windowVisible"]} parsed={s["parsed"]} route={s["route"]}'
    check("a frame is saved while watching", first, detail)
    files = frame_files()
    check("the frame is a file on disk", len(files) == 1, str(files))
    if files:
        check("and it's a real picture", is_real_picture(files[0]))
    debug("moment")
    moment = wait_until(lambda: query("SELECT position,file FROM frames WHERE is_moment=1"), timeout=6)
    check("saving a moment keeps that frame", moment, state()["banner"])
    check("it says so over the player", state()["banner"].startswith("moment|Saved"), state()["banner"])
    if moment:
        path = DATA / f"Profiles/{state()['profileid']}/Frames/{moment[0][1]}"
        check("the moment is a real picture", path.exists() and is_real_picture(str(path)))
    media_eval("document.querySelector('video').pause(); true")
    debug("closetab")
    time.sleep(0.5)

    print_section("Frames: video in another origin that can't be read")
    open_page("/tainted")
    start_playing(200)
    tainted = wait_until(lambda: query("SELECT f.file FROM frames f JOIN titles t ON t.id=f.title_id WHERE t.name LIKE 'Tainted%'"), timeout=50)
    check("the frame can still be saved", tainted, f'{state()["media"]} visible={state()["windowVisible"]}')
    if tainted:
        path = DATA / f"Profiles/{state()['profileid']}/Frames/{tainted[0][0]}"
        check("and it's the picture, cropped to the video", is_real_picture(str(path)))
        width, height = image_size(path)
        check("in the film's own proportions", 1.7 < width / max(1, height) < 1.85, f"{width}x{height}")
    media_eval("document.querySelector('video').pause(); true")
    debug("closetab")
    time.sleep(0.5)

    print_section("Frames: cleaning up")
    sessions = query("SELECT DISTINCT session_id FROM frames WHERE is_moment=1")
    if sessions and sessions[0][0]:
        moment_files_before = query("SELECT file FROM frames WHERE is_moment=1")
        debug("deletesession", id=str(sessions[0][0]))
        time.sleep(0.5)
        left = query("SELECT is_moment FROM frames WHERE session_id=?", sessions[0][0])
        check("removing a session removes its frames", not left, str(left))
        kept = query("SELECT file,session_id FROM frames WHERE is_moment=1")
        check("but a moment you saved stays", kept and kept[0][1] is None, str(kept))
        check("and its file too", kept and (DATA / f"Profiles/{state()['profileid']}/Frames/{moment_files_before[0][0]}").exists())

    debug("settings", frames="0")
    open_page("/tainted")
    before = query("SELECT count(*) FROM frames")[0][0]
    start_playing(300)
    time.sleep(32)
    check("with frames switched off, none are saved", query("SELECT count(*) FROM frames")[0][0] == before)
    media_eval("document.querySelector('video').pause(); true")
    debug("closetab")


def downloads_tests():
    """e2e.py's downloads_tests. A stream saves as one .ts or .mp4 here (the Mac makes a .movpkg),
    and films played from a download say "This PC"."""
    print_section("Downloads: a player that hides its file behind HLS requests")
    fresh_profile("Downloads")
    open_page("/rezka/film/1-test-movie-2021.html")
    text = wait_until(lambda: (lambda t: t if "/cdn/stream/1080.mp4" in t else None)(read_debug("downloads")), timeout=15)
    check("the player's :hls: requests collapse to whole files", text and ":hls:" not in text, text or "")
    best = next((l for l in (text or "").splitlines() if l.startswith("best=")), "")
    check("the best quality is picked", best.endswith("/cdn/stream/1080.mp4"), best)
    check("the subtitle track is found", text and "source subtitle" in text, text or "")
    pill = wait_until(lambda: evaluate("document.querySelector('cineon-download') ? 'yes' : 'no'").strip() == "yes", timeout=5)
    check("a download button sits on the player", pill)

    debug("download")
    items = wait_download("done", timeout=60)
    check("the file downloads with the page's cookie and address", items, str(downloads_list()))
    if not items:
        return
    item = items[0]
    path = Path(item["file"]) if item.get("file", "-") != "-" else None
    film_size = (ROOT / "fixtures/film.mp4").stat().st_size
    check("the whole file arrived", path and path.exists() and path.stat().st_size == film_size, item.get("file"))
    check("it's named after the film and quality", "Test Movie" in item.get("name", "") or "Тестовый" in item.get("name", ""), item.get("name"))
    check("it's in the downloads folder", path and same_folder(path, DATA / "Movies"), item.get("file"))
    check("its subtitles are saved too", item.get("subtitles") == "1", item.get("subtitles"))
    label = evaluate("(() => { const h = document.querySelector('cineon-download'); return h ? 'present' : 'gone' })()")
    check("the button stays to say it's saved", label.strip() == "present", label)

    print_section("Downloads: playing the copy on this PC")
    debug("playdownload", id=item["id"])
    p = wait_until(lambda: (lambda t: t if "playing=true" in t else None)(read_debug("player")), timeout=10)
    check("the native player starts", p, read_debug("player"))
    check("the screen stays on in the native player too", wait_until(keeps_awake, timeout=6))
    debug("playerseek", to="30")
    caption = wait_until(lambda: (lambda t: t if "caption=Hello from subtitles" in t else None)(read_debug("player")), timeout=6)
    check("downloaded subtitles show in the player", caption, read_debug("player"))
    time.sleep(4)
    lit = read_debug("player")
    amb = next((l for l in lit.splitlines() if l.startswith("ambient=")), "ambient=0")
    if "windowVisible=false" in lit:
        say("  SKIP  ambient light: the window is minimised or hidden, and ambient pauses when it can't be seen")
    else:
        check("ambient light follows the downloaded film", not amb.startswith("ambient=0.0 ") and "RGB(r: 0.0, g: 0.0, b: 0.0)" not in amb, amb)
    check("the download is linked to a title in the library", item.get("title", "-1") != "-1", item.get("title"))
    time.sleep(16)
    debug("route", to="downloads")
    time.sleep(1)
    check("leaving the player lets the PC sleep", wait_until(lambda: not keeps_awake(), timeout=6))
    rows = query("SELECT position FROM downloads WHERE id=?", int(item["id"]))
    check("its place is kept", rows and rows[0][0] > 30, str(rows))
    sessions = query("SELECT host FROM sessions")
    check("watching it goes on the timeline", any(r[0] == "This PC" for r in sessions), str(sessions))

    print_section("Downloads: a film that only streams as a playlist")
    open_page("/hls-film")
    start_playing()
    text = wait_until(lambda: (lambda t: t if "best=" in t and t.split("best=")[1].startswith("http") else None)(read_debug("downloads")), timeout=15)
    best = next((l for l in (text or "").splitlines() if l.startswith("best=")), "")
    check("the playlist is found", best.endswith("/hls/index.m3u8"), best or read_debug("downloads"))
    debug("download")
    items = wait_until(lambda: (lambda d: d if d and d[0].get("kind") == "hls" and d[0].get("status") in ("done", "failed") else None)(downloads_list()), timeout=180, every=2)
    check("the stream saves as one file", items and items[0].get("status") == "done" and items[0].get("file", "").lower().endswith((".ts", ".mp4")), str(items))
    media_eval("document.querySelector('video').pause(); true")
    debug("closetab")


def chrome_tests():
    """The Mac checks its traffic lights here. Windows has caption buttons at the right of the same
    bar instead, so these check that they fit in it, come back after full screen, and that a click
    in the bar beside the drag area reaches the app."""
    print_section("Window: the top bar and its buttons")
    say("  SKIP  traffic lights centred in the bar: Mac only (checking the caption buttons instead)")
    debug("fullscreen", on="0")
    debug("route", to="library")
    time.sleep(0.8)

    def fits():
        value = state()["lights"]
        try:
            width, height = (int(n) for n in value.split(","))
        except ValueError:
            return False
        # Three buttons of at least 30 px, no taller than the 56 px bar (a height of 0 means Windows
        # didn't say, which isn't what this checks).
        return width >= 90 and 0 <= height <= 56

    check("the window's caption buttons fit in the top bar", wait_until(fits, timeout=8), state()["lights"])
    debug("windowsize", w="1200", h="800")
    check("and stay there after a resize", wait_until(fits, timeout=4), state()["lights"])
    debug("fullscreen", on="1")
    hidden = wait_until(lambda: state()["lights"] == "fullscreen", timeout=8)
    time.sleep(1.5)
    debug("fullscreen", on="0")
    back = wait_until(fits, timeout=8)
    check("and come back after full screen", hidden and back, state()["lights"])
    # The logo is a button in the title bar: the window must let this click through to the app.
    debug("windowclick", x="40", y="28")
    check("a click on the logo in the bar reaches the app", wait_until(lambda: state()["route"] == "home", timeout=4), state()["route"])


def memory_tests():
    print_section("Memory")
    s = state()
    # The Mac's limit is 400 MB of resident memory. Windows' working set also counts the WinUI and
    # WebView2 host libraries mapped into the process, so the same app measures higher here.
    check("app process stays light", int(s["memory"].rstrip("MB")) < 600, s["memory"])
    say(f"    app process {s['memory']} (working set; WebView2 runs in its own processes)")


def print_section(title):
    say(title)


SECTIONS = [
    ("main", main_tests),
    ("autopilot", lambda: mac.autopilot_tests()),
    ("rescue", lambda: mac.rescue_tests()),
    ("frame", frame_tests),
    ("awake", lambda: mac.awake_tests()),
    ("tools", lambda: mac.tools_tests()),
    ("downloads", downloads_tests),
    ("season", lambda: mac.season_tests()),
    ("series", lambda: mac.series_tests()),
    ("alerts", lambda: mac.alerts_tests()),
    ("together", lambda: mac.together_tests()),
    ("cloud", lambda: mac.cloud_tests()),
    ("profile", lambda: mac.profile_tests()),
    ("chrome", chrome_tests),
    ("memory", memory_tests),
]


def run_section(name, body):
    current_section[0] = name
    if time.time() - started_at > BUDGET_SECONDS:
        say(f"SKIP  section '{name}': past the time budget of {BUDGET_SECONDS / 60:.0f} minutes")
        record(f"section '{name}' ran within the time budget", False, "skipped")
        return
    try:
        body()
    except Exception as error:  # noqa: BLE001  (one broken section mustn't stop the rest)
        record(f"section '{name}' finished without an error", False, f"{type(error).__name__}: {error}")
        say(traceback.format_exc())
    if section_failures.get(name):
        try:
            screenshot(f"failed-{name}")
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        ensure_app()
    except RuntimeError as error:
        say(f"  !!  {error}")


def startup():
    current_section[0] = "startup"
    say("Startup")
    profiles = wait_until(lambda: (DATA / "profiles.json").exists(), timeout=20)
    record("the data folder is set up on first launch", profiles, str(DATA))
    time.sleep(1)
    s = wait_until(lambda: (lambda st: st if st["rules"].startswith("5/") else None)(state()), timeout=80)
    check("all five rule lists compile on first launch", s, str(state().get("rules")))
    if s:
        count = int(s["rules"].split("/")[1])
        check("over 100,000 blocking rules active", count > 100_000, str(count))
    debug("settings", minimumSeconds="5")


def main():
    if not EXE.exists():
        sys.exit(f"Build first: {EXE} is missing (dotnet build windows/Cineon.App -c Debug -r win-x64)")
    for name in ("film.mp4", "short.mp4", "hls/index.m3u8"):
        if not (ROOT / "fixtures" / name).exists():
            sys.exit(f"Make the fixtures first: fixtures/{name} is missing (see the Makefile's fixtures targets)")
    for tool in ("node", "ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} isn't on PATH")

    global server_process
    say(f"Cineon: {EXE}\nData: {DATA}\nTest port: {DEBUG_PORT}\nArtifacts: {ARTIFACTS}")
    kill_strays()
    time.sleep(0.5)
    server_log = open(ARTIFACTS / "fixture-server.log", "w", encoding="utf-8")
    server_process = subprocess.Popen(["node", str(ROOT / "fixtures/server.js"), str(PORT)], stdout=server_log, stderr=subprocess.STDOUT)
    make_fake_browsers(FAKE_BROWSERS)

    try:
        if not wait_until(lambda: _server_up(), timeout=10):
            sys.exit(f"The fixture server didn't start on port {PORT}")
        launch_app()
        startup()
        only = os.environ.get("CINEON_E2E_ONLY")
        chosen = [n.strip() for n in only.split(",")] if only else [name for name, _ in SECTIONS]
        known = dict(SECTIONS)
        for name in chosen:
            if name not in known:
                say(f"SKIP  unknown section '{name}' (known: {', '.join(known)})")
                continue
            run_section(name, known[name])
    except Exception as error:  # noqa: BLE001
        record("the run finished", False, f"{type(error).__name__}: {error}")
        say(traceback.format_exc())
    finally:
        current_section[0] = "end"
        try:
            if app_alive():
                (ARTIFACTS / "final-state.txt").write_text(request("state", 20), encoding="utf-8")
        except (OSError, http.client.HTTPException):
            pass
        if not os.environ.get("CINEON_E2E_KEEP"):
            quit_app()
            if app_alive():
                kill_tree(app_process.pid)
        if server_process is not None:
            server_process.terminate()
        for name in ("crash.log", "debug-output.txt", "profiles.json"):
            if (DATA / name).exists():
                shutil.copy(DATA / name, ARTIFACTS / name)

    failed = [r for r in results if not r[2]]
    say(f"\n{len(results) - len(failed)} of {len(results)} passed. Data in {DATA}")
    if failed:
        say("Failed:")
        for section, name, _, detail in failed:
            say(f"  [{section}] {name}" + (f"   [{detail[:300]}]" if detail else ""))
    log_file.close()
    sys.exit(1 if failed else 0)


def _server_up():
    try:
        LOCAL.open(BASE + "/", timeout=2).read()
        return True
    except (OSError, http.client.HTTPException):
        return False


if __name__ == "__main__":
    main()
