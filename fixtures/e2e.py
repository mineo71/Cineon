#!/usr/bin/env python3
"""End-to-end test: drives a real Debug build of Cineon against the fake streaming site.

    python3 fixtures/e2e.py

Uses a throwaway data folder, so real libraries and timelines are never touched. It opens the
app on screen and takes about ten minutes. CINEON_E2E_ONLY=autopilot,rescue,frame runs just those parts.
"""
import base64
import glob
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "build/Build/Products/Debug/Cineon.app"
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
DATA = Path(os.environ.get("CINEON_E2E_DATA") or tempfile.mkdtemp(prefix="cineon-e2e-"))
FAKE_BROWSERS = Path(os.environ.get("CINEON_E2E_BROWSERS") or tempfile.mkdtemp(prefix="cineon-e2e-browsers-"))
OUTPUT = DATA / "debug-output.txt"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  {mark}  {name}" + (f"   [{detail}]" if detail and not ok else ""), flush=True)


def debug(path, **params):
    url = f"cineon://debug/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    # The environment goes with every link: if the test build has crashed, opening a link starts it
    # again, and without these it would start on the real profile.
    subprocess.run(["open", "-g", "--env", f"CINEON_DATA_DIR={DATA}", "--env", f"CINEON_IMPORT_ROOT={FAKE_BROWSERS}",
                    "-a", str(APP), url], check=True)


def click(x, y):
    debug("click", x=x, y=y)
    time.sleep(0.45)


def state():
    if OUTPUT.exists():
        OUTPUT.unlink()
    debug("state")
    for _ in range(50):
        time.sleep(0.1)
        text = OUTPUT.read_text() if OUTPUT.exists() else ""
        if "profile=" in text and "memory=" in text:
            out = {}
            for line in text.splitlines():
                key, _, value = line.partition("=")
                out[key] = value
            return out
    raise RuntimeError("no state from app. It wrote: " + repr((OUTPUT.read_text() if OUTPUT.exists() else "nothing")[:400]))


def evaluate(js, world="page"):
    if OUTPUT.exists():
        OUTPUT.unlink()
    debug("eval", js=js, world=world)
    return read_output()


def media_eval(js):
    if OUTPUT.exists():
        OUTPUT.unlink()
    debug("mediaeval", js=js)
    return read_output()


def read_output():
    for _ in range(50):
        time.sleep(0.1)
        if OUTPUT.exists():
            return OUTPUT.read_text()
    return ""


def wait_until(predicate, timeout=15, every=0.3):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(every)
    return None


def db():
    profile = state()["profileid"]
    return sqlite3.connect(f"file:{DATA}/Profiles/{profile}/cineon.sqlite?mode=ro", uri=True)


def query(sql, *args):
    conn = db()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def open_page(path):
    debug("open", url=BASE + path)
    wait_until(lambda: state().get("url", "").endswith(path) and state().get("parsed") != "-", timeout=10)
    time.sleep(0.8)


def play_muted():
    wait_until(lambda: state().get("media") != "-" or True, timeout=1)
    time.sleep(0.8)
    media_eval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.muted=true; v.play(); true")


def make_fake_browsers(root):
    """An Arc with a history and saved tabs, made of invented sites and real film names."""
    profile = root / "Arc/User Data/Default"
    profile.mkdir(parents=True, exist_ok=True)
    now = int((time.time() + 11644473600) * 1_000_000)
    day = 86400 * 1_000_000
    rows = [
        ("https://uakino.example/filmy/dune-2021.html", "Дюна / Dune (2021) дивитися онлайн українською", 6, now - 40 * day),
        ("https://uakino.example/filmy/arrival.html", "Прибуття / Arrival (2016) дивитися онлайн", 3, now - 90 * day),
        ("https://uakino.example/filmy/past-lives.html", "Минулі життя / Past Lives (2023) дивитися онлайн", 2, now - 120 * day),
        ("https://uaserial.example/serial/severance/2-sezon/3-seriya", "Розрив 2 сезон 3 серія дивитися онлайн", 1, now - 6 * day),
        ("https://uaserial.example/serial/severance/2-sezon/4-seriya", "Розрив 2 сезон 4 серія дивитися онлайн", 1, now - 5 * day),
        ("https://flixdemo.example/watch/oppenheimer-19xk2", "Watch Oppenheimer (2023) Full Movie Online Free | FlixDemo", 2, now - 200 * day),
        ("https://flixdemo.example/watch/spirited-away-88qq1", "Watch Spirited Away (2001) Full Movie Online Free | FlixDemo", 4, now - 300 * day),
        ("https://news.example/2025/story", "Some news story", 1, now - 2 * day),
        ("https://www.google.com/search?q=films", "films - Google Search", 1, now - 1 * day),
        ("https://shop.example/item/1", "A pair of shoes", 1, now - 3 * day),
    ]
    db_file = profile / "History"
    if db_file.exists():
        db_file.unlink()
    conn = sqlite3.connect(db_file)
    conn.execute("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)")
    conn.executemany("INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time) VALUES(?,?,?,0,?)", rows)
    conn.commit()
    conn.close()
    (root / "Arc/StorableSidebar.json").write_text(json.dumps({"sidebar": {"containers": [{"items": [
        "an-id",
        {"data": {"tab": {"savedURL": "https://kinoteka.example/", "savedTitle": "Kinoteka"}}},
        {"data": {"tab": {"savedURL": "https://kinoteka.example/film/the-zone-of-interest", "savedTitle": "The Zone of Interest дивитися онлайн"}}},
    ]}]}}))


def main():
    if not APP.exists():
        sys.exit(f"Build first: {APP} is missing")

    # A server left from an earlier run remembers which sites the tests killed, so start afresh.
    subprocess.run(["pkill", "-f", "fixtures/server.js"])
    time.sleep(0.3)
    server = subprocess.Popen(["node", str(ROOT / "fixtures/server.js"), str(PORT)], stdout=subprocess.DEVNULL)
    subprocess.run(["pkill", "-f", "Debug/Cineon.app/Contents/MacOS/Cineon"])
    time.sleep(0.5)
    make_fake_browsers(FAKE_BROWSERS)
    # AppKit normally swallows an Objective-C exception and carries on. Inside Swift async code that
    # leaves the concurrency runtime in a bad state and the app falls over later, somewhere unrelated.
    # Crashing on the exception itself points at the real cause.
    subprocess.run(["open", "-n", "--env", f"CINEON_DATA_DIR={DATA}", "--env", f"CINEON_IMPORT_ROOT={FAKE_BROWSERS}", str(APP),
                    "--args", "-NSApplicationCrashOnExceptions", "YES"], check=True)

    try:
        run_tests()
    finally:
        # CINEON_E2E_KEEP=1 leaves the app open afterwards, to look at a hang.
        if not os.environ.get("CINEON_E2E_KEEP"):
            debug("state")
            time.sleep(0.2)
            subprocess.run(["pkill", "-f", "Debug/Cineon.app/Contents/MacOS/Cineon"])
        server.terminate()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} of {len(results)} passed. Data in {DATA}")
    sys.exit(1 if failed else 0)


def run_tests():
    print("Startup")
    assert wait_until(lambda: OUTPUT.parent.exists() and (DATA / "profiles.json").exists(), 10)
    time.sleep(1)
    s = wait_until(lambda: (lambda st: st if st["rules"].startswith("5/") else None)(state()), timeout=60)
    check("all five rule lists compile on first launch", s, str(state().get("rules")))
    if s:
        count = int(s["rules"].split("/")[1])
        check("over 100,000 blocking rules active", count > 100_000, str(count))

    debug("settings", minimumSeconds="5")

    # For working on one part: CINEON_E2E_ONLY=autopilot,rescue,frame
    only = os.environ.get("CINEON_E2E_ONLY")
    if only:
        for name in only.split(","):
            globals()[f"{name}_tests"]()
        return

    print("Film page: messy title, cross-origin player, ad traps")
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

    print("Tracking playback")
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
        print("  SKIP  ambient light: the window is covered, and ambient pauses when it can't be seen")
    else:
        check("ambient light is reading colour from the film", z, " ".join(f"{k}={amb.get(k)}" for k in ["ambient", "route", "media", "windowVisible", "appActive", "ambientOn", "url"]))

    print("Video whose frames can't be read")
    open_page("/tainted")
    time.sleep(0.8)
    media_eval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.muted=true; v.play(); true")
    tainted = wait_until(lambda: state()["framesBlocked"] == "true", timeout=8)
    check("cross-origin video falls back without errors", tainted, state()["framesBlocked"])
    time.sleep(7)
    print("    fallback ambient:", state()["ambient"])
    debug("closetab")
    time.sleep(0.5)

    print("Resume across a reload of the page")
    pos_before = query("SELECT position FROM progress")[0][0]
    debug("closetab")
    time.sleep(1)
    s = state()
    check("closing the tab leaves none open", s["tabs"] == "0", s["tabs"])
    open_page("/watch/dune-part-two-2024")
    resumed = wait_until(lambda: (lambda m: m if m != "-" else None)(state()["media"]), timeout=10) or "-"
    position = float(resumed.split("/")[0]) if resumed != "-" else 0
    check("video resumed at the saved place", position > pos_before - 15, f"{position} vs {pos_before}")

    print("Finishing a film")
    media_eval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.muted=true; v.currentTime = v.duration * 0.95; v.play(); true")
    status = wait_until(lambda: (lambda r: r if r and r[0][0] == "watched" else None)(query("SELECT status FROM titles WHERE name LIKE 'Dune%'")), timeout=25)
    check("film moves to watched at 92 percent", status, str(query("SELECT name,status FROM titles")))

    print("Ukrainian series page")
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

    print("Structured data page")
    open_page("/tv/the-bear/episode")
    s = state()
    check("JSON-LD series name wins over page title", s["parsed"].startswith("The Bear|"), s["parsed"])
    check("JSON-LD season and episode", "S2E7" in s["parsed"], s["parsed"])

    print("Video inside nested web components")
    open_page("/shadow")
    time.sleep(1)
    debug("eval", js="window.__deep=document.querySelector('shadow-outer').shadowRoot.querySelector('shadow-inner').shadowRoot.querySelector('video'); window.__deep.muted=true; window.__deep.play(); window.dispatchEvent(new Event('pointerdown')); 1")
    seen = wait_until(lambda: "playing=true" in state()["media"], timeout=12)
    check("video two shadow roots deep is detected", seen, state()["media"])
    debug("eval", js="window.__deep.pause(); 1")
    time.sleep(0.5)

    print("Episode kept only in the address fragment")
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

    print("Short clip")
    before = query("SELECT count(*) FROM sessions")[0][0]
    open_page("/clip")
    play_muted()
    time.sleep(7)
    after = query("SELECT count(*) FROM sessions")[0][0]
    check("a 30-second clip is not tracked", before == after, f"{before} to {after}")

    print("Turning shields off for one site")
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

    print("Sites that aren't about films")
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

    print("Silent autoplay banner")
    before = query("SELECT count(*) FROM sessions")[0][0]
    open_page("/hero")
    time.sleep(8)
    playing = evaluate("!document.getElementById('v').paused")
    check("the banner really is playing", playing.strip() == "1", playing)
    after = query("SELECT count(*) FROM sessions")[0][0]
    check("a silent autoplay banner is not tracked", before == after, f"{before} to {after}")

    print("Hostile navigation")
    open_page("/redirector")
    time.sleep(1.5)
    s = state()
    check("scripted redirect blocked", s["url"].endswith("/redirector"), s["url"])
    check("redirect counted", "redirects: 0" not in s["blocked"], s["blocked"])

    downloads = set(os.listdir(Path.home() / "Downloads"))
    open_page("/download-trap")
    time.sleep(1.5)
    check("fake download blocked", "player-update.dmg" not in set(os.listdir(Path.home() / "Downloads")) - downloads)

    print("Legitimate navigation still works")
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
    x, y = rect.strip().split(",")
    click(x, y)
    opened = wait_until(lambda: int(state()["tabs"]) == tabs_before + 1, timeout=5)
    check("real click on a same-site new-tab link opens a tab", opened, f'{state()["tabs"]} {state()["toast"]}')

    print("Search everywhere")
    debug("addsite", url=BASE + "/", name="FlixDemo", search=BASE + "/search?q=%s")
    debug("addsite", url="http://localhost:%d/" % PORT, name="LocalDemo")
    time.sleep(0.5)
    # Aimed at the Debug copy. A bare cineon:// link would start the installed app and search there.
    subprocess.run(["open", "-g", "--env", f"CINEON_DATA_DIR={DATA}", "--env", f"CINEON_IMPORT_ROOT={FAKE_BROWSERS}",
                    "-a", str(APP), "cineon://search?q=" + urllib.parse.quote("dune part")], check=True)
    s = wait_until(lambda: (lambda st: st if "/search?q=dune" in st["search"] else None)(state()), timeout=5)
    check("search opens on sites with search set up", s, state()["search"])
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

    print("Learning search from a page")
    debug("open", url=f"http://localhost:{PORT}/")
    learned = wait_until(lambda: "localhost|http://localhost:%d/search?q=%%s" % PORT in state()["sites"], timeout=8)
    check("search address learned from the site's form", learned, state()["sites"])

    print("Hibernation")
    open_page("/same-site")
    debug("hibernate")
    time.sleep(0.5)
    s = state()
    check("idle tabs release their web view", "[h]" in s["tablist"], s["tablist"])
    debug("selecttab", i=0)
    time.sleep(1.5)
    s = state()
    check("tab wakes up on selection", s["url"] != "-" and "[h]" not in s["tablist"].split(",")[0], s["tablist"])

    print("Profiles")
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
    debug("switchprofile", name=state()["profile"] if False else json.loads((DATA / "profiles.json").read_text())["profiles"][0]["name"])
    back = wait_until(lambda: state()["profile"] != "Guest", timeout=6)
    check("switching back works", back)
    time.sleep(1)
    check("first profile's library is intact", query("SELECT count(*) FROM titles")[0][0] == titles_before)

    print("Import from another browser")
    debug("switchprofile", name="Guest")
    wait_until(lambda: state()["profile"] == "Guest", timeout=6)
    time.sleep(1)
    if OUTPUT.exists():
        OUTPUT.unlink()
    debug("importreport", apply="Arc")
    report = wait_until(lambda: (lambda t: t if "applied" in t else None)(OUTPUT.read_text() if OUTPUT.exists() else ""), timeout=15) or ""
    check("the fake Arc is found and read", "browser=Arc" in report, report)
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
    debug("importreport", apply="Arc")
    time.sleep(2)
    again = query("SELECT count(*) FROM sessions WHERE duration=0")[0][0]
    check("importing twice adds nothing", again == timeline, f"{timeline} to {again}")

    autopilot_tests()
    rescue_tests()
    frame_tests()
    awake_tests()
    tools_tests()
    downloads_tests()
    season_tests()
    series_tests()
    alerts_tests()
    together_tests()
    cloud_tests()
    profile_tests()
    chrome_tests()

    print("Memory")
    s = state()
    check("app process stays light", int(s["memory"].rstrip("MB")) < 400, s["memory"])
    print(f"    app process {s['memory']}")


def fresh_profile(name):
    """A clean library with only local sites, so nothing here searches the real internet."""
    debug("addprofile", name=name, switch="1")
    wait_until(lambda: state()["profile"] == name, timeout=6)
    time.sleep(1)
    debug("removesites")
    debug("settings", minimumSeconds="5", metadata="0")
    time.sleep(0.3)


def media_position():
    media = state()["media"]
    return float(media.split("/")[0]) if media != "-" else -1


def start_playing(position=None):
    time.sleep(0.8)
    seek = f"v.currentTime={position};" if position is not None else ""
    media_eval(f"window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.muted=true; {seek} v.play(); true")


def start_playing_with_sound():
    """Same, but the way someone who already clicked would hear it."""
    time.sleep(0.8)
    media_eval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.play(); true")


def wait_banner(prefix, timeout=15):
    return wait_until(lambda: state()["banner"].startswith(prefix), timeout=timeout)


def fetch(path):
    urllib.request.urlopen(BASE + path).read()


def autopilot_tests():
    print("Learning what you skip")
    fresh_profile("Autopilot")
    open_page("/serial/rozryv/2-sezon/1-seriya")
    start_playing()
    wait_until(lambda: query("SELECT count(*) FROM sessions")[0][0] > 0, timeout=20)
    # Holding the right arrow: many small jumps, which together are one skip.
    start = media_position()
    for _ in range(4):
        media_eval("window.dispatchEvent(new Event('pointerdown')); var v=document.querySelector('video'); v.currentTime=v.currentTime+25; true")
        time.sleep(0.4)
    asked = wait_banner("intro|")
    check("several small jumps are offered as one intro to skip", asked, state()["banner"])
    check("the offer names the series", "Розрив" in state()["banner"], state()["banner"])

    # A real click on the card's button. It must not reach the player underneath.
    rect = media_eval("(()=>{const r=document.querySelector('cineon-banner').getBoundingClientRect();return Math.round(r.right)+','+Math.round(r.top+r.height/2)})()")
    x, y = rect.strip().split(",")
    click(int(x) - 75, y)
    saved = wait_until(lambda: query("SELECT start,end,sightings FROM skip_rules WHERE kind='intro'"), timeout=5)
    check("clicking Always skip saves the rule", saved, state()["banner"])
    if saved:
        check("the rule covers the whole jump", saved[0][1] - saved[0][0] > 80, str(saved))
        check("the rule starts where the jumping started", abs(saved[0][0] - start) < 8, f"{saved} from {start}")
    check("the click didn't pause the film", "playing=true" in state()["media"], state()["media"])

    print("Skipping it in the next episode")
    open_page("/serial/rozryv/2-sezon/2-seriya")
    start_playing(max(0, saved[0][0] - 2) if saved else 0)
    jumped = wait_until(lambda: media_position() >= saved[0][1] - 1 if saved else False, timeout=12)
    check("the intro is skipped by itself", jumped, state()["media"])
    check("it says so, with a way back", state()["banner"].startswith("skipped|"), state()["banner"])
    wait_until(lambda: query("SELECT count(*) FROM sessions WHERE episode=2")[0][0] > 0, timeout=15)
    debug("banner", banner="skipped", action="undo")
    undone = wait_until(lambda: media_position() < saved[0][1] - 20 if saved else False, timeout=4)
    check("Undo goes back to the start of the intro", undone, state()["media"])
    time.sleep(3)
    check("an undone skip doesn't run again in this episode", media_position() < saved[0][1] - 20 if saved else False, state()["media"])
    misses = query("SELECT misses FROM skip_rules WHERE kind='intro'")
    check("the undo is remembered against the rule", misses and misses[0][0] == 1, str(misses))

    print("Next episode")
    media_eval("var v=document.querySelector('video'); v.currentTime=v.duration-60; v.play(); true")
    offered = wait_banner("next|Next: S2 E3|offer", timeout=12)
    check("near the end, the next episode is offered without taking over", offered, state()["banner"])
    debug("banner", banner="next", action="play")
    moved = wait_until(lambda: state()["url"].endswith("/3-seriya"), timeout=8)
    check("Play now opens the next episode's address", moved, state()["url"])
    credits = wait_until(lambda: query("SELECT start,sightings FROM skip_rules WHERE kind='credits'"), timeout=3)
    check("leaving with a minute to go is learned as the credits", credits and 50 < credits[0][0] < 70, str(credits))
    playing = wait_until(lambda: "playing=true" in state()["media"], timeout=10)
    check("the next episode starts by itself", playing, state()["media"])
    sound = media_eval("document.querySelector('video').muted")
    check("and with its sound on", sound.strip() == "0", sound)

    wait_until(lambda: query("SELECT count(*) FROM sessions WHERE episode=3")[0][0] > 0, timeout=15)
    media_eval("var v=document.querySelector('video'); v.currentTime=v.duration-62; v.play(); true")
    wait_banner("next|Next: S2 E4", timeout=12)
    debug("banner", banner="next", action="play")
    wait_until(lambda: state()["url"].endswith("/4-seriya"), timeout=8)
    credits = wait_until(lambda: (lambda r: r if r and r[0][1] >= 2 else None)(query("SELECT start,sightings FROM skip_rules WHERE kind='credits'")), timeout=3)
    check("the second time, the two sightings agree", credits, str(query("SELECT start,sightings FROM skip_rules WHERE kind='credits'")))

    wait_until(lambda: "playing=true" in state()["media"], timeout=10)
    wait_until(lambda: query("SELECT count(*) FROM sessions WHERE episode=4")[0][0] > 0, timeout=15)
    media_eval("var v=document.querySelector('video'); v.currentTime=v.duration-40; v.play(); true")
    counting = wait_banner("next|Next: S2 E5|countdown", timeout=12)
    check("once learned, the credits start a countdown", counting, state()["banner"])
    showing = media_eval("document.querySelector('cineon-banner') !== null")
    media_eval("document.querySelector('video').pause(); true")
    time.sleep(2.5)
    gone = media_eval("document.querySelector('cineon-banner') === null")
    check("pausing cancels the countdown", showing.strip() == "1" and gone.strip() == "1", f"{showing} {gone}")
    media_eval("document.querySelector('video').play(); true")
    wait_banner("next|Next: S2 E5|countdown", timeout=8)
    debug("banner", banner="next", action="no")
    time.sleep(0.5)
    media_eval("var v=document.querySelector('video'); v.currentTime=v.duration-2; v.play(); true")
    time.sleep(5)
    check("saying no means it stays put, even at the end", state()["url"].endswith("/4-seriya"), state()["url"])

    print("Next episode rolling on at the end")
    open_page("/serial/rozryv/2-sezon/5-seriya")
    start_playing()
    wait_until(lambda: query("SELECT count(*) FROM sessions WHERE episode=5")[0][0] > 0, timeout=15)
    # The film is at the credits here, and the rule was learned above.
    media_eval("var v=document.querySelector('video'); v.currentTime=v.duration-2; v.play(); true")
    ended = wait_banner("next|Next: S2 E6|countdown", timeout=10)
    check("when an episode ends, the countdown starts", ended, state()["banner"])
    rolled = wait_until(lambda: state()["url"].endswith("/6-seriya"), timeout=14)
    check("and it rolls on when the countdown ends", rolled, state()["url"])

    print("The last episode")
    wait_until(lambda: query("SELECT count(*) FROM sessions WHERE episode=6")[0][0] > 0, timeout=20)
    media_eval("var v=document.querySelector('video'); v.currentTime=v.duration-2; v.play(); true")
    time.sleep(6)
    check("nothing is offered when there's no next episode", not state()["banner"].startswith("next|Next: S2 E7"), state()["banner"])

    print("Episodes listed on the page")
    debug("open", url=BASE + "/series/drama/1-mentalist-2008.html#t:238-s:3-e:5")
    wait_until(lambda: state().get("parsed", "-") != "-", timeout=8)
    start_playing()
    wait_until(lambda: query("SELECT count(*) FROM sessions WHERE season=3 AND episode=5")[0][0] > 0, timeout=15)
    media_eval("var v=document.querySelector('video'); v.currentTime=v.duration-30; v.play(); true")
    wait_banner("next|Next: S3 E6", timeout=12)
    debug("banner", banner="next", action="play")
    switched = wait_until(lambda: "S3E6" in state()["parsed"], timeout=8)
    check("the page's own episode list is used", switched, state()["parsed"])
    swapped = media_eval("document.querySelector('video').src")
    check("the page swapped its video without reloading", "e=6" in swapped, swapped)
    media_eval("document.querySelector('video').pause(); true")


def rescue_tests():
    print("Rescue: another address of the same site")
    fresh_profile("Rescue")
    debug("addsite", url=BASE + "/", name="OtherDemo", search=BASE + "/search?q=%s")
    time.sleep(0.3)
    alive = f"http://flix-alive.localhost:{PORT}/watch/dune-part-two-2024"
    dying = f"http://flix-dying.localhost:{PORT}/watch/dune-part-two-2024"
    debug("open", url=alive)
    wait_until(lambda: "flix-alive" in state()["url"] and state()["parsed"] != "-", timeout=10)
    debug("closetab")
    time.sleep(0.5)
    debug("open", url=dying)
    wait_until(lambda: "flix-dying" in state()["url"] and state()["parsed"] != "-", timeout=10)
    start_playing()
    wait_until(lambda: query("SELECT count(*) FROM sessions")[0][0] > 0, timeout=20)
    media_eval("var v=document.querySelector('video'); v.currentTime=300; v.play(); true")
    wait_until(lambda: (lambda r: r and r[0][0] > 295)(query("SELECT position FROM progress")), timeout=16)
    saved = query("SELECT position FROM progress")[0][0]
    debug("closetab")
    time.sleep(0.5)

    fetch("/kill?host=flix-dying")
    debug("resume", url=dying, at=str(saved))
    moved = wait_until(lambda: "flix-alive" in state()["url"], timeout=15)
    check("a dead address moves to another address of the site", moved, f'{state()["url"]} {state()["failure"]} {state()["rescue"]}')
    check("it says what happened", "Continuing on" in state()["toast"], state()["toast"])
    resumed = wait_until(lambda: media_position() > saved - 5, timeout=12)
    check("it carries on from the same second", resumed, f'{state()["media"]} vs {saved}')
    debug("closetab")
    time.sleep(0.5)

    print("Rescue: another site altogether")
    gone = f"http://gone.localhost:{PORT}/watch/dune-part-two-2024"
    debug("open", url=gone)
    wait_until(lambda: "gone.localhost" in state()["url"] and state()["parsed"] != "-", timeout=10)
    start_playing()
    time.sleep(7)
    media_eval("var v=document.querySelector('video'); v.currentTime=420; v.play(); true")
    wait_until(lambda: (lambda r: r and r[0][0] > 415)(query("SELECT position FROM progress")), timeout=16)
    saved = query("SELECT position FROM progress")[0][0]
    titles_before = query("SELECT count(*) FROM titles")[0][0]
    debug("closetab")
    time.sleep(0.5)

    fetch("/kill?host=gone")
    debug("resume", url=gone, at=str(saved))
    found = wait_until(lambda: "dune-part-two:true" in state()["rescue"], timeout=20)
    check("the same film is found on another site", found, f'{state()["rescue"]} {state()["failure"]}')
    s = state()
    check("Dune (1984) isn't what it picked", "dune-1984" not in s["rescue"].split("|")[2].split(";")[0], s["rescue"])
    check("the trailer isn't offered", "trailer" not in s["rescue"], s["rescue"])
    check("a link to another site isn't offered", "ads.example" not in s["rescue"], s["rescue"])
    counting = int(s["rescue"].split("|")[3]) >= 0
    check("a certain match counts down before opening", counting, s["rescue"])
    opened = wait_until(lambda: state()["url"].endswith("/film/dune-part-two"), timeout=10)
    check("then it opens by itself", opened, state()["url"])
    resumed = wait_until(lambda: media_position() > saved - 5, timeout=12)
    check("and carries on from the same second there", resumed, f'{state()["media"]} vs {saved}')
    time.sleep(7)
    check("it's still the same film in the library", query("SELECT count(*) FROM titles")[0][0] == titles_before, str(query("SELECT name FROM titles")))
    media_eval("document.querySelector('video').pause(); true")
    debug("closetab")
    time.sleep(0.5)

    print("Rescue: a page that was taken down")
    page_path = "/film/vanishing-film-2020"
    open_page(page_path)
    start_playing()
    wait_until(lambda: query("SELECT count(*) FROM sessions s JOIN titles t ON t.id=s.title_id WHERE t.name LIKE 'Vanishing%'")[0][0] > 0, timeout=20)
    media_eval("var v=document.querySelector('video'); v.currentTime=100; v.pause(); true")
    time.sleep(1.5)
    debug("closetab")
    time.sleep(0.5)
    fetch(f"/kill?path={page_path}")
    # Searches its own site too, which has moved it: the only other sites are local here.
    debug("addsite", url=f"http://localhost:{PORT}/", name="LocalDemo", search=f"http://localhost:{PORT}/search?q=%s")
    time.sleep(0.3)
    debug("resume", url=BASE + page_path, at="100")
    looking = wait_until(lambda: "pageMissing" in state()["rescue"], timeout=10)
    check("a 404 on a film you were watching starts looking", looking, f'{state()["rescue"]} {state()["url"]}')
    found = wait_until(lambda: "vanishing-film-elsewhere:true" in state()["rescue"] or "vanishing-film-elsewhere" in state()["url"], timeout=15)
    check("and finds it elsewhere", found, state()["rescue"])
    debug("closetab")
    time.sleep(0.5)

    print("Rescue: where it should stay out of the way")
    debug("open", url=f"http://nothing.localhost:{PORT}/same-site")
    wait_until(lambda: "nothing.localhost" in state()["url"], timeout=8)
    fetch("/kill?host=nothing")
    debug("closetab")
    time.sleep(0.3)
    debug("resume", url=f"http://nothing.localhost:{PORT}/same-site")
    wait_until(lambda: state()["failure"] != "-", timeout=8)
    time.sleep(1)
    check("a page that's nothing to do with a film just fails", state()["rescue"] == "-" and state()["failure"] != "-", f'{state()["rescue"]} {state()["failure"]}')
    debug("closetab")
    time.sleep(0.3)

    open_page("/film/dune-1984")
    debug("findelsewhere")
    asked = wait_until(lambda: "manual" in state()["rescue"], timeout=5)
    check("asking by hand looks for what the page is about", asked, state()["rescue"])
    wait_until(lambda: "|finished|" in state()["rescue"], timeout=15)
    time.sleep(6)
    check("and never opens anything by itself", state()["url"].endswith("/film/dune-1984"), state()["url"])
    debug("closetab")
    time.sleep(0.3)

    print("Rescue: the video stops, the page doesn't")
    open_page("/film/dune-part-two")
    start_playing()
    wait_until(lambda: "playing=true" in state()["media"], timeout=8)
    time.sleep(2)
    media_eval("var v=document.querySelector('video'); v.src='/missing.mp4'; v.load(); true")
    stopped = wait_until(lambda: "videoFailed" in state()["rescue"], timeout=12)
    check("a video that errors starts looking elsewhere", stopped, state()["rescue"])
    debug("closetab")
    time.sleep(0.5)

    open_page("/stall-film")
    start_playing()
    wait_until(lambda: "playing=true" in state()["media"], timeout=8)
    debug("stallseconds", s="3")
    media_eval("var v=document.querySelector('video'); v.currentTime=800; v.play(); true")
    stuck = wait_until(lambda: "videoStalled" in state()["rescue"], timeout=25)
    check("a video that hangs is noticed", stuck, f'{state()["rescue"]} {state()["media"]}')
    debug("closetab")
    time.sleep(0.5)

    print("Rescue: landing on a different video")
    debug("resume", url=BASE + "/film/dune-part-two", at="500", expected="5000")
    time.sleep(2)
    start_playing()
    warned = wait_until(lambda: "length is different" in state()["toast"], timeout=8)
    check("a very different length doesn't jump anywhere", warned, state()["toast"])
    check("it stays at the start", media_position() < 100, state()["media"])
    media_eval("document.querySelector('video').pause(); true")
    debug("closetab")
    time.sleep(0.3)


def frame_files():
    return sorted(glob.glob(str(DATA / f"Profiles/{state()['profileid']}/Frames/*/*.jpg")))


def is_real_picture(path):
    """Colourful, unlike an empty screen. The fixture is colour bars, so this is a fair test."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", "scale=8:4,format=rgb24", "-f", "rawvideo", "-"],
        capture_output=True,
    ).stdout
    return len(out) >= 96 and (max(out) - min(out)) > 120


def keeps_awake():
    """Whether this app's process holds macOS's 'don't dim the display' assertion right now."""
    # Only the test build counts. An installed Cineon playing something at the same time doesn't.
    pids = subprocess.run(["pgrep", "-f", str(APP / "Contents/MacOS/Cineon")], capture_output=True, text=True).stdout.split()
    out = subprocess.run(["pmset", "-g", "assertions"], capture_output=True, text=True).stdout
    return any("PreventUserIdleDisplaySleep" in line and "Playing a film in Cineon" in line
               and any(f"pid {pid}(" in line for pid in pids)
               for line in out.splitlines())


def awake_tests():
    print("Staying awake while a film plays")
    fresh_profile("Awake")
    open_page("/tv/the-bear/episode")
    check("nothing keeps the Mac awake before playing", not keeps_awake())
    start_playing(60)
    check("the screen stays on while it plays", wait_until(keeps_awake, timeout=10))
    media_eval("document.querySelector('video').pause(); true")
    check("pausing lets the Mac sleep again", wait_until(lambda: not keeps_awake(), timeout=8))
    start_playing()
    on_again = wait_until(keeps_awake, timeout=10)
    debug("closetab")
    check("closing the tab lets it sleep too", on_again and wait_until(lambda: not keeps_awake(), timeout=8))


def fields_of(text):
    return dict(l.split("=", 1) for l in (text or "").splitlines() if "=" in l)


def tools_tests():
    print("Player tools: voice boost, second subtitles, sleep timer, media keys")
    fresh_profile("Tools")
    # Carrying on watching is the one way a page may start with sound, the way a click would.
    debug("keepwatching", url=BASE + "/tv/the-bear/episode", at="40")
    wait_until(lambda: state()["url"].endswith("/tv/the-bear/episode"), timeout=10)
    playing = wait_until(lambda: state()["media"].endswith("playing=true"), timeout=15)
    check("a film to try them on plays with sound", playing, state()["media"])
    debug("settings", voiceBoost="1")
    boost = wait_until(lambda: (lambda f: f if f.get("state") == "on" else None)(fields_of(read_debug("voiceboost"))), timeout=10)
    check("voice boost turns on for a player whose sound the page can read", boost, read_debug("voiceboost"))
    loud = wait_until(lambda: float(fields_of(read_debug("voiceboost")).get("level", "-1")) > 0.001, timeout=8)
    check("and the film still has sound through it", loud, read_debug("voiceboost"))
    debug("settings", voiceBoost="0")
    off = wait_until(lambda: fields_of(read_debug("voiceboost")).get("state") == "off", timeout=8)
    still = wait_until(lambda: float(fields_of(read_debug("voiceboost")).get("level", "-1")) > 0.001, timeout=8)
    check("turning it off keeps the sound", off and still, read_debug("voiceboost"))

    subs = DATA / "second.uk.vtt"
    subs.write_text("WEBVTT\n\n00:00:01.000 --> 00:30:00.000\nДругий рядок\n", encoding="utf-8")
    debug("subs2", file=str(subs))
    second = wait_until(lambda: fields_of(read_debug("subs2state")).get("text") == "Другий рядок", timeout=10)
    check("a subtitle file shows as a second line over the film", second, read_debug("subs2state"))
    debug("subs2", clear="1")
    gone = wait_until(lambda: fields_of(read_debug("subs2state")).get("text", "x") == "", timeout=6)
    check("and goes away again", gone, read_debug("subs2state"))

    shown = wait_until(lambda: fields_of(read_debug("nowplaying")).get("playing") == "1", timeout=8)
    check("Control Center shows what's playing", shown and "The Bear" in read_debug("nowplaying"), read_debug("nowplaying"))
    debug("remote", cmd="toggle")
    paused = wait_until(lambda: state()["media"].endswith("playing=false") and fields_of(read_debug("nowplaying")).get("playing") == "0", timeout=8)
    check("the play/pause key pauses it", paused, read_debug("nowplaying") + state()["media"])
    debug("intent", name="playpause")
    resumed = wait_until(lambda: fields_of(read_debug("nowplaying")).get("playing") == "1", timeout=8)
    check("Siri's play or pause plays it again", resumed, read_debug("nowplaying"))

    debug("sleep", mode="seconds", s="6")
    fading = wait_until(lambda: fields_of(read_debug("sleepstate")).get("fading") == "true", timeout=6)
    check("the sleep timer fades the sound out", fading, read_debug("sleepstate"))
    stopped = wait_until(lambda: state()["media"].endswith("playing=false"), timeout=14)
    check("and pauses the film", stopped, state()["media"])
    restored = wait_until(lambda: abs(float(fields_of(read_debug("voiceboost")).get("volume", "-1")) - 1) < 0.01, timeout=6)
    check("with the volume back for next time", restored, read_debug("voiceboost"))
    done = wait_until(lambda: fields_of(read_debug("sleepstate")).get("active") == "false", timeout=4)
    check("and the timer is done", done, read_debug("sleepstate"))

    media_eval("var v=document.querySelector('video'); v.currentTime = v.duration - 12; v.play(); true")
    wait_until(lambda: state()["media"].endswith("playing=true"), timeout=6)
    debug("sleep", mode="end")
    ends = wait_until(lambda: state()["media"].endswith("playing=false"), timeout=25)
    check("'at the end of this' stops when it ends", ends, state()["media"])
    debug("closetab")


def season_tests():
    print("Downloads: a whole season, then watching it")
    fresh_profile("Season")
    open_page("/series/drama/1-mentalist-2008.html#t:238-s:3-e:5")
    start_playing(30)
    wait_until(lambda: state()["track"] != "-", timeout=15)
    debug("season", **{"from": "all"})
    done = wait_until(lambda: (lambda f: f if f.get("finished") == "true" else None)(fields_of(read_debug("seasonstate"))), timeout=150, every=2)
    check("every episode on the page is found", done and done.get("episodes") == "S3 E5,S3 E6,S3 E7", read_debug("seasonstate"))
    check("and each one queued", done and done.get("queued") == "S3 E5,S3 E6,S3 E7", read_debug("seasonstate"))
    items = wait_until(lambda: (lambda d: d if len(d) >= 3 and all(i["status"] == "done" for i in d) else None)(downloads_list()), timeout=120, every=2)
    check("the three episodes download, two at a time", items, str(downloads_list()))
    if not items:
        return
    sources = sorted(i["source"].split("/")[-1] for i in items)
    check("each from its own file", sources == ["film.mp4", "film.mp4?e=6", "film.mp4?e=7"], str(sources))
    debug("closetab")
    first = next(i for i in items if i["source"].endswith("/film.mp4"))
    debug("playdownload", id=first["id"])
    wait_until(lambda: "playing=true" in read_debug("player"), timeout=10)
    debug("playerseek", to="895")
    up = wait_until(lambda: (lambda f: f if f.get("next") not in (None, "-") else None)(fields_of(read_debug("upnext"))), timeout=20)
    check("the next downloaded episode is offered at the end", up, read_debug("upnext"))
    read_debug("upnext", play="1")
    moved = wait_until(lambda: fields_of(read_debug("upnext")).get("playing") == (up or {}).get("next"), timeout=8)
    check("and plays", moved, read_debug("upnext"))
    binned = wait_until(lambda: all(i["id"] != first["id"] for i in downloads_list()), timeout=8)
    check("the watched episode goes to the Bin", binned, str([i["id"] for i in downloads_list()]))
    debug("route", to="downloads")


def restart_app():
    """Kills the test build the hard way, as a crash would, and starts it again on the same data."""
    subprocess.run(["pkill", "-9", "-f", "Debug/Cineon.app/Contents/MacOS/Cineon"])
    wait_until(lambda: subprocess.run(["pgrep", "-f", "Debug/Cineon.app/Contents/MacOS/Cineon"], capture_output=True).returncode != 0, timeout=10)
    subprocess.run(["open", "-n", "--env", f"CINEON_DATA_DIR={DATA}", "--env", f"CINEON_IMPORT_ROOT={FAKE_BROWSERS}", str(APP),
                    "--args", "-NSApplicationCrashOnExceptions", "YES"], check=True)
    time.sleep(4)
    return wait_until(lambda: (lambda st: st if st.get("profile") else None)(state_or_none()), timeout=20)


def state_or_none():
    try:
        return state()
    except RuntimeError:
        return None


SERIES_PAGE = "/series/drama/2-two-seasons-2019.html#t:300-s:1-e:1"
SERIES_EPISODES = "S1 E1,S1 E2,S2 E1,S2 E2,S2 E3"


def series_tests():
    print("Downloads: a whole series")
    fresh_profile("Series")
    open_page(SERIES_PAGE)
    start_playing(30)
    wait_until(lambda: state()["track"] != "-", timeout=15)
    debug("season", **{"from": "series"})
    asked = wait_until(lambda: (lambda f: f if f.get("proposal") not in (None, "-") else None)(fields_of(read_debug("seasonstate"))), timeout=60, every=1)
    check("every season is found, the hidden one too", asked and asked.get("proposal") == SERIES_EPISODES, read_debug("seasonstate"))
    check("and it asks first, with a size", asked and int(asked.get("proposalBytes", "0")) > 0 and fields_of(read_debug("seasonstate")).get("running") == "false",
          read_debug("seasonstate"))
    debug("seasonconfirm")
    done = wait_until(lambda: (lambda f: f if f.get("finished") == "true" else None)(fields_of(read_debug("seasonstate"))), timeout=180, every=2)
    check("saying yes gets every episode of both seasons", done and done.get("queued") == SERIES_EPISODES, read_debug("seasonstate"))
    items = wait_until(lambda: (lambda d: d if len(d) >= 5 and all(i["status"] == "done" for i in d) else None)(downloads_list()), timeout=120, every=2)
    sources = sorted(i["source"].split("/")[-1] for i in (items or []))
    check("each from its own file", sources == ["film.mp4?s=1&e=1", "film.mp4?s=1&e=2", "film.mp4?s=2&e=1", "film.mp4?s=2&e=2", "film.mp4?s=2&e=3"],
          str(sources))
    debug("closetab")

    print("Downloads: a whole series, carried on after Cineon closes")
    fresh_profile("Series again")
    open_page(SERIES_PAGE)
    start_playing(30)
    wait_until(lambda: state()["track"] != "-", timeout=15)
    debug("season", **{"from": "series"})
    wait_until(lambda: fields_of(read_debug("seasonstate")).get("proposal") not in (None, "-"), timeout=60, every=1)
    debug("seasonconfirm")
    started = wait_until(lambda: fields_of(read_debug("seasonstate")).get("queued", "-") not in ("-", ""), timeout=60, every=0.5)
    check("a series job starts", started, read_debug("seasonstate"))
    restarted = restart_app()
    after = fields_of(read_debug("seasonstate"))
    check("after a crash it's still there, paused", restarted and after.get("paused") == "true" and after.get("finished") == "false", str(after))
    debug("seasonresume")
    done = wait_until(lambda: (lambda f: f if f.get("finished") == "true" else None)(fields_of(read_debug("seasonstate"))), timeout=180, every=2)
    check("carrying on gets the rest", done and done.get("queued") == SERIES_EPISODES, read_debug("seasonstate"))
    items = wait_until(lambda: (lambda d: d if len(d) >= 5 and all(i["status"] == "done" for i in d) else None)(downloads_list()), timeout=120, every=2)
    check("with every episode downloaded once and nothing left stopped", items and len(items) == 5, str(downloads_list()))
    debug("closetab")


def alerts_tests():
    print("New episodes")
    fresh_profile("Alerts")
    # Its own series: the season test's player streams no real video, so nothing gets watched there.
    read_debug("addtitle", name="Slow Horses", year="2022", kind="series", status="watching")
    rows = wait_until(lambda: query("SELECT id FROM titles WHERE kind='series' AND status='watching' LIMIT 1"), timeout=5)
    check("a series being watched is in the library", rows, str(query("SELECT name,kind,status FROM titles")))
    if not rows:
        return
    title = rows[0][0]
    debug("settings", alerts="1")
    debug("fakeepisodes", title=str(title), list="3x5:2020-01-01,3x6:2020-01-02,3x7:2099-01-01")
    first = fields_of(read_debug("checknew"))
    check("the first look only remembers what's out", first.get("notified") == "-" and f"latest=S3 E6" in read_debug("checknew"), read_debug("checknew"))
    debug("fakeepisodes", title=str(title), list="3x5:2020-01-01,3x6:2020-01-02,3x7:2020-01-03,3x8:2099-01-01")
    later = read_debug("checknew")
    check("a new episode is announced", "Season 3, episode 7 is out" in fields_of(later).get("notified", ""), later)
    check("and shows on Home", fields_of(later).get("fresh") == "1", later)


def profile_secret():
    profile = state()["profileid"]
    return json.loads((DATA / f"Profiles/{profile}/together.json").read_text())["secret"]


def cloud_items(secret):
    """What the cloud holds for this secret. Empty until the app has registered it, which it does
    on its first upload, so asking too early is "not yet" rather than a failure."""
    try:
        return convex("query", "library:all", deviceSecret=secret) or []
    except RuntimeError as error:
        if "UNKNOWN_DEVICE" in str(error):
            return []
        raise


def cloud_tests():
    print("Ratings in the cloud")
    fresh_profile("Cloud")
    read_debug("addtitle", name="Heat", year="1995", status="watched")
    rows = wait_until(lambda: query("SELECT id FROM titles WHERE name='Heat'"), timeout=5)
    if not rows:
        check("a film to rate", False)
        return
    heat = rows[0][0]
    debug("rate", id=str(heat), halves="15")
    check("a rating of 7.5 is saved", query("SELECT rating FROM titles WHERE id=?", heat) == [(15,)])
    secret = wait_until(lambda: (DATA / f"Profiles/{state()['profileid']}/together.json").exists() and profile_secret(), timeout=10)
    backed = wait_until(lambda: any(i.get("rating") == 15 and i["key"].startswith("n:heat") for i in cloud_items(secret)), timeout=20)
    check("and backed up to the cloud", backed, str(cloud_items(secret)))
    debug("deletetitle", id=str(heat))
    time.sleep(1)
    read_debug("addtitle", name="Heat", year="1995", status="none")
    read_debug("cloud", _wait=30, do="sync")
    back = wait_until(lambda: query("SELECT rating, status FROM titles WHERE name='Heat'") == [(15, "watched")], timeout=10)
    check("clearing and adding it again brings the stars back", back, str(query("SELECT rating, status FROM titles WHERE name='Heat'")))

    print("Ratings in the cloud: another profile, with the recovery code")
    fresh_profile("Cloud copy")
    read_debug("addtitle", name="Heat", year="1995", status="none")
    adopted = fields_of(read_debug("adopt", _wait=40, code=secret)).get("adopted") == "true"
    restored = adopted and wait_until(lambda: query("SELECT rating FROM titles WHERE name='Heat'") == [(15,)], timeout=10)
    check("a recovery code restores the ratings elsewhere", restored, str(query("SELECT rating FROM titles WHERE name='Heat'")))


def chrome_tests():
    print("Window: the top bar and its buttons")
    debug("fullscreen", on="0")
    debug("route", to="library")
    time.sleep(0.8)

    def centred():
        value = state()["lights"]
        try:
            x, y = (int(n) for n in value.split(","))
        except ValueError:
            return False
        return 20 <= x <= 36 and abs(y - 28) <= 1

    check("the window's buttons sit in the middle of the top bar", wait_until(centred, timeout=8), state()["lights"])
    debug("windowsize", w="1200", h="800", animate="1")
    check("and stay there after a resize", wait_until(centred, timeout=4), state()["lights"])
    debug("fullscreen", on="1")
    hidden = wait_until(lambda: state()["lights"] == "fullscreen", timeout=8)
    # macOS ignores leaving full screen while the animation into it is still running.
    time.sleep(2.5)
    debug("fullscreen", on="0")
    back = wait_until(centred, timeout=8)
    check("and come back after full screen", hidden and back, state()["lights"])
    # The logo is in what used to be the title bar, so this is a click AppKit must let through.
    debug("windowclick", x="110", y="28")
    check("a click in the bar beside them reaches the app", wait_until(lambda: state()["route"] == "home", timeout=4), state()["route"])


def profile_tests():
    print("Profile and pet")
    stats = fields_of(read_debug("stats"))
    check("the profile works out its numbers", "hours" in stats and stats.get("pet", "").startswith("p"), str(stats))
    for route in ["profile", "rate", "library", "home"]:
        debug("route", to=route)
        time.sleep(0.8)
        check(f"the {route} page opens", state()["route"] == route, state()["route"])
    written = fields_of(read_debug("sharecard")).get("written") == "true"
    card = DATA / "share-card.png"
    check("a share card can be saved as a picture", written and card.exists() and card.stat().st_size > 20_000,
          str(card.stat().st_size if card.exists() else 0))


def frame_tests():
    print("Frames: video the page can read")
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

    print("Frames: video in another origin that can't be read")
    open_page("/tainted")
    start_playing(200)
    tainted = wait_until(lambda: query("SELECT f.file FROM frames f JOIN titles t ON t.id=f.title_id WHERE t.name LIKE 'Tainted%'"), timeout=50)
    check("the frame can still be saved", tainted, f'{state()["media"]} visible={state()["windowVisible"]}')
    if tainted:
        path = DATA / f"Profiles/{state()['profileid']}/Frames/{tainted[0][0]}"
        check("and it's the picture, cropped to the video", is_real_picture(str(path)))
        size = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)], capture_output=True, text=True).stdout
        parts = dict(line.strip().split(": ") for line in size.splitlines() if ": " in line)
        ratio = int(parts.get("pixelWidth", 0)) / max(1, int(parts.get("pixelHeight", 1)))
        check("in the film's own proportions", 1.7 < ratio < 1.85, size)
    media_eval("document.querySelector('video').pause(); true")
    debug("closetab")
    time.sleep(0.5)

    print("Frames: cleaning up")
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


def read_debug(path, _wait=6, **params):
    """Runs a debug command that writes several lines, ending with end=1. Commands that talk to
    the server need a longer `_wait`, or their late reply lands on top of the next command's."""
    if OUTPUT.exists():
        OUTPUT.unlink()
    debug(path, **params)
    for _ in range(int(_wait * 10)):
        time.sleep(0.1)
        text = OUTPUT.read_text() if OUTPUT.exists() else ""
        if text.endswith("end=1"):
            return text
    return ""


def fields(line):
    out = {}
    for part in line.split("\t"):
        key, sep, value = part.partition("=")
        if sep:
            out[key] = value
    return out


def downloads_list():
    return [fields(line) for line in read_debug("downloads").splitlines() if line.startswith("download\t")]


def wait_download(status, timeout):
    def done():
        items = downloads_list()
        return items if items and items[0].get("status") == status else None
    return wait_until(done, timeout=timeout, every=1)


def downloads_tests():
    print("Downloads: a player that hides its file behind HLS requests")
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
    check("it's in the downloads folder", path and str(path).startswith(str(DATA / "Movies")), item.get("file"))
    check("its subtitles are saved too", item.get("subtitles") == "1", item.get("subtitles"))
    label = evaluate("(() => { const h = document.querySelector('cineon-download'); return h ? 'present' : 'gone' })()")
    check("the button stays to say it's saved", label.strip() == "present", label)

    print("Downloads: playing the copy on this Mac")
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
        print("  SKIP  ambient light: the window is covered, and ambient pauses when it can't be seen")
    else:
        check("ambient light follows the downloaded film", not amb.startswith("ambient=0.0 ") and "RGB(r: 0.0, g: 0.0, b: 0.0)" not in amb, amb)
    check("the download is linked to a title in the library", item.get("title", "-1") != "-1", item.get("title"))
    time.sleep(16)
    debug("route", to="downloads")
    time.sleep(1)
    check("leaving the player lets the Mac sleep", wait_until(lambda: not keeps_awake(), timeout=6))
    rows = query("SELECT position FROM downloads WHERE id=?", int(item["id"]))
    check("its place is kept", rows and rows[0][0] > 30, str(rows))
    sessions = query("SELECT host FROM sessions")
    check("watching it goes on the timeline", any(r[0] == "This Mac" for r in sessions), str(sessions))

    print("Downloads: a film that only streams as a playlist")
    open_page("/hls-film")
    start_playing()
    text = wait_until(lambda: (lambda t: t if "best=" in t and t.split("best=")[1].startswith("http") else None)(read_debug("downloads")), timeout=15)
    best = next((l for l in (text or "").splitlines() if l.startswith("best=")), "")
    check("the playlist is found", best.endswith("/hls/index.m3u8"), best)
    debug("download")
    items = wait_until(lambda: (lambda d: d if d and d[0].get("kind") == "hls" and d[0].get("status") in ("done", "failed") else None)(downloads_list()), timeout=180, every=2)
    check("the stream saves as a package", items and items[0].get("status") == "done" and items[0].get("file", "").endswith(".movpkg"), str(items))
    media_eval("document.querySelector('video').pause(); true")
    debug("closetab")


TOGETHER = os.environ.get("CINEON_TOGETHER_URL", "https://stoic-pelican-635.eu-west-1.convex.cloud")


def convex(kind, path, **args):
    """Calls the Together server the way a friend's Cineon would."""
    body = json.dumps({"path": path, "args": args, "format": "json"})
    # curl, because it trusts the system's certificates and some Python installs don't.
    out = subprocess.run(
        ["curl", "-s", "--max-time", "15", "-H", "Content-Type: application/json", "-d", body, f"{TOGETHER}/api/{kind}"],
        capture_output=True, text=True, check=True,
    ).stdout
    reply = json.loads(out)
    if reply.get("status") != "success":
        raise RuntimeError(reply.get("errorMessage"))
    return reply.get("value")


def together_dump():
    return read_debug("together", dump="1")


def dump_line(text, key):
    return next((l[len(key) + 1:] for l in text.splitlines() if l.startswith(key + "=")), "")


def friend_party(code):
    party = convex("query", "parties:get", code=code)
    if not party:
        return None
    expected = party["position"] + (max(0, party["now"] - party["updatedAt"]) / 1000 * party["rate"] if party["playing"] else 0)
    return {**party, "expected": expected}


def player_time():
    out = media_eval("String(document.querySelector('video').currentTime)").strip()
    try:
        return float(out)
    except ValueError:
        return -1


def together_tests():
    print("Together: a friend's list, by code")
    fresh_profile("Together")
    bo = base64.b64encode(os.urandom(32)).decode()
    convex("mutation", "people:register", deviceSecret=bo, name="Bo")
    share = convex("mutation", "shares:create", deviceSecret=bo, label="Bo's watched films", titles=[
        {"name": "Arrival", "year": 2016, "kind": "film", "imdbId": "tt2543164"},
        {"name": "Severance", "year": 2022, "kind": "series"},
    ])
    debug("together", code=share["code"].lower())
    shares = wait_until(lambda: (lambda d: d if "Arrival" in dump_line(d, "shares") else None)(together_dump()), timeout=15)
    check("a friend's list opens from its code, typed any way", shares, together_dump())
    debug("together", addshared="0")
    rows = wait_until(lambda: query("SELECT status FROM titles WHERE name='Arrival'"), timeout=5)
    check("a film from it goes to my backlog", rows and rows[0][0] == "backlog", str(rows))

    print("Together: a challenge")
    challenge = convex("mutation", "challenges:create", deviceSecret=bo,
                       title={"name": "Dune: Part Two", "year": 2024, "kind": "film"}, totalEpisodes=1)
    debug("together", code=challenge["code"])
    joined = wait_until(lambda: (lambda d: d if "Together:" in dump_line(d, "challenge") else None)(together_dump()), timeout=15)
    check("I join it by code and show in the race", joined, together_dump())
    rows = query("SELECT status FROM titles WHERE name='Dune: Part Two'")
    check("its film goes to my backlog so I can find it", rows and rows[0][0] == "backlog", str(rows))

    open_page("/watch/dune-part-two-2024")
    start_playing(300)
    wait_until(lambda: query("SELECT position FROM progress WHERE position > 290"), timeout=20)
    debug("together", refresh="1")

    def my_fraction():
        line = dump_line(together_dump(), "challenge")
        for part in line.split("|")[-1].split(","):
            name, _, rest = part.partition(":")
            if name == "Together":
                return float(rest.split(":")[0])
        return 0

    moved = wait_until(lambda: my_fraction() > 0.01, timeout=15)
    check("what I watch moves my progress bar", moved, dump_line(together_dump(), "challenge"))
    convex("mutation", "challenges:report", deviceSecret=bo, code=challenge["code"], fraction=1, watchedEpisodes=1,
           label="Finished", finished=True)
    debug("together", refresh="1")
    won = wait_until(lambda: "winner=Bo" in dump_line(together_dump(), "challenge"), timeout=15)
    check("the first to finish wins", won, dump_line(together_dump(), "challenge"))

    print("Together: hosting a watch party")
    debug("together", party="start")
    line = wait_until(lambda: (lambda d: dump_line(d, "party") if dump_line(d, "party") not in ("", "-") else None)(together_dump()), timeout=15)
    check("a party starts from the film playing", line, together_dump())
    if line:
        code = line.split("|")[0]
        convex("mutation", "parties:join", deviceSecret=bo, code=code)
        party = friend_party(code)
        mine = player_time()
        check("a friend joins at my second", party and party["playing"] and abs(party["expected"] - mine) < 6,
              f"{party and party['expected']} vs {mine}")
        members = wait_until(lambda: "Bo" in dump_line(together_dump(), "party"), timeout=8)
        check("I see who's in", members, dump_line(together_dump(), "party"))
        media_eval("document.querySelector('video').pause(); true")
        paused = wait_until(lambda: not friend_party(code)["playing"], timeout=8)
        check("pausing reaches the friend", paused)
        media_eval("document.querySelector('video').currentTime = 600; true")
        jumped = wait_until(lambda: abs(friend_party(code)["expected"] - 600) < 3, timeout=8)
        check("a jump reaches the friend", jumped, str(friend_party(code)))
        convex("mutation", "parties:react", deviceSecret=bo, code=code, emoji="🍿")
        shown = wait_until(lambda: "Bo 🍿" in state()["banner"] or "Bo 🍿" in state()["toast"], timeout=8)
        check("a friend's reaction shows on the film", shown, f'{state()["banner"]} {state()["toast"]}')
        convex("mutation", "parties:say", deviceSecret=bo, code=code, text="this scene!")
        heard = wait_until(lambda: "Bo:this scene!" in dump_line(together_dump(), "messages"), timeout=10)
        check("a friend's message reaches the party chat", heard, dump_line(together_dump(), "messages"))
        debug("together", say="right?")
        sent = wait_until(lambda: any(m["text"] == "right?" for m in (friend_party(code) or {}).get("messages", [])), timeout=10)
        check("and mine reaches them", sent, str((friend_party(code) or {}).get("messages")))
        pets = dump_line(together_dump(), "pets")
        # Mine is a pet code ("p1-…"); Bo registered without one, so his shows as "-".
        mine = pets.split(",")[0].split(":", 1)[1] if ":" in pets else ""
        check("people in the party carry their pets", mine.startswith("p1-") and "Bo:-" in pets, pets)
        debug("together", party="leave")
        ended = wait_until(lambda: (friend_party(code) or {}).get("ended"), timeout=8)
        check("ending the party ends it for everyone", ended)

    print("Together: following a friend's party")
    hosted = convex("mutation", "parties:create", deviceSecret=bo, pageUrl=BASE + "/film/dune-part-two",
                    position=420, playing=False, rate=1)
    debug("together", code=hosted["code"])
    opened = wait_until(lambda: state()["url"].endswith("/film/dune-part-two"), timeout=10)
    check("joining opens the host's page", opened, state()["url"])
    at = wait_until(lambda: abs(player_time() - 420) < 3, timeout=15)
    check("and goes to the host's second", at, str(player_time()))
    convex("mutation", "parties:update", deviceSecret=bo, code=hosted["code"], position=700, playing=False, rate=1)
    followed = wait_until(lambda: abs(player_time() - 700) < 3, timeout=10)
    check("and follows the host's jumps", followed, str(player_time()))

    # Muted, because a page may only start sound after a click, and nobody clicks in a test.
    media_eval("var v=document.querySelector('video'); v.muted=true; window.__seeks=0; v.addEventListener('seeking', () => window.__seeks++); true")
    convex("mutation", "parties:update", deviceSecret=bo, code=hosted["code"], position=100, playing=True, rate=1)

    def drift():
        party = friend_party(hosted["code"])
        return abs(player_time() - party["expected"]) if party else 99

    playing = wait_until(lambda: media_eval("String(!document.querySelector('video').paused)").strip() == "true" and drift() < 2.5, timeout=15)
    check("plays along when the host plays", playing, f"drift={drift():.1f}")
    media_eval("window.__seeks=0; true")
    time.sleep(14)
    seeks = media_eval("String(window.__seeks)").strip()
    check("and stays with the host without jumping back", seeks == "0" and drift() < 2.5, f"seeks={seeks} drift={drift():.1f}")
    time.sleep(10)  # Well past the 30 s after which someone who stays quiet drops off the list.
    names = [m["name"] for m in (friend_party(hosted["code"]) or {}).get("members", [])]
    check("the host still sees me after half a minute", "Together" in names, str(names))
    convex("mutation", "parties:leave", deviceSecret=bo, code=hosted["code"])
    over = wait_until(lambda: dump_line(together_dump(), "party") == "-", timeout=8)
    check("when the host ends it, I'm out too", over, dump_line(together_dump(), "party"))
    debug("closetab")


if __name__ == "__main__":
    main()
