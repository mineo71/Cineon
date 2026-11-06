#!/usr/bin/env python3
"""Writes corpus.jsonl: the inputs ParsingDump.swift and ParsingDump.cs both run through.

One JSON object per line, {"t": <kind>, ...}. Deterministic: run it again and the file is the same.
    python3 windows/Cineon.Core.Tests/Parsing/MacParity/make_corpus.py
"""
import json
import os
import random
import sys

# Optional: a seed, a scale for the fuzz section and an output path, for a bigger run outside the repo.
rng = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 20261106)
scale = int(sys.argv[2]) if len(sys.argv) > 2 else 1
out = []


def add(case_type, **fields):
    out.append({"t": case_type, **fields})


# MARK: Names, as sites write them

english = [
    "Dune: Part Two", "The Lego Movie", "1917", "2012", "Oppenheimer", "Severance", "The Bear", "Breaking Bad",
    "Game of Thrones", "One Piece", "Attack on Titan", "Spider-Man: Across the Spider-Verse",
    "Mission: Impossible – Dead Reckoning", "Fast & Furious 9", "Scary Movie", "Vanishing Film",
    "Star Wars: Episode IV - A New Hope", "The Office", "Friends", "The Boys", "WALL·E", "Se7en", "M3GAN", "9",
    "Up", "It", "Us", "Her", "Zootopia", "Coco", "Kill Bill: Vol. 1", "Léon: The Professional", "Pokémon",
    "Æon Flux", "Charlie Chaplin's \"The Rink\"", "Ocean's Eleven", "Amélie", "Big Buck Bunny", "Inside Out 2",
    "Shōgun", "Blade Runner 2049", "2001: A Space Odyssey", "The Matrix Reloaded", "Toy Story 4", "Alien³",
    "Twelve Monkeys", "Frozen II", "The Godfather Part II", "Avatar: The Way of Water", "Doctor Who",
]
cyrillic = [
    "Дюна: Частина друга", "Дюна", "Головоломка 2", "Менталист", "Пацаны", "Розрив", "Сверхъестественное",
    "Одиссея", "Паук-Нуар", "Создание «Рыцаря Семи Королевств»", "Ёлки 2", "Ґрінч", "Їжак у тумані", "Шрек 2",
    "Тіні забутих предків", "Інтерстеллар", "Мавка. Лісова пісня", "Шерлок", "Тайна Коко", "Ведьмак", "Відьмак",
    "Друзі", "Офіс", "Чорне дзеркало", "Черное зеркало", "Леон", "Наруто", "Магическая битва", "Атака титанов",
    "Поднятие уровня в одиночку", "Пес Патрон", "Інферно", "Кіборги", "Слуга народу", "Брат 2", "Москва слезам не верит",
    "Фільм про фільм", "Кино про кино", "Сериал", "Онлайн", "Мультфильм", "Аніме",
]
pairs = [
    ("Дюна", "Dune"), ("Інтерстеллар", "Interstellar"), ("Пацаны", "The Boys"), ("Розрив", "Severance"),
    ("Головоломка 2", "Inside Out 2"), ("Відьмак", "The Witcher"), ("Менталист", "The Mentalist"), ("Леон", "Léon"),
]
names = english + cyrillic

en_shapes = [
    "Watch {n} ({y}) Full Movie Online Free HD | FlixHub", "{n} ({y}) - Watch Online", "{n} | Netflix",
    "Watch {n} Online Free on 123Movies", "{n} S02E04 - Watch Online", "{n} Season 3 Episode 7 | Stream",
    "{n} 2x05", "{n} English Sub/Dub on Aniwatch.to", "{n} - Official Trailer", "{n} (1080p HD)",
    "{n} [{y}] 4K HDR", "Stream {n} free – Plex", "{n} : Free Download, Borrow, and Streaming : Internet Archive",
    "\"{n}\"", "{n} coming soon", "{n} :: Kinopoisk", "FlixHub - {n} - Watch free", "{n} ({y}) • Letterboxd",
    "{n} — Watch the full movie in HD", "{n} season 1 episode 12 english subbed", "{n} Episode 1050 English Sub",
    "{n} S1 E3 | Hulu", "{n} (TV Series {y}– ) - IMDb", "{n} (Trailer)", "Watch {n} {y} online free download 720p",
    "{n} 60fps 4K - Official Blender Foundation Short Film - YouTube", "{n}", "{n} ~ Crunchyroll", "{n} » Watch",
    "{n} · Streaming", "{n} ({y}) | Site", "  {n}  ", "{n} | Season 2 | Episode 10",
    "{n} - S03E01 - Pilot", "{n} (Director's cut) {y}", "“{n}”", "{n}\"", "'{n}'", "{n} - Prime Video",
]
uk_shapes = [
    "{n} ({y}) дивитися онлайн безкоштовно українською", "{n} 2 сезон 4 серія дивитися онлайн",
    "Дивитися {n} онлайн в хорошій якості HD 1080", "{n} / {en} ({y}) — UAKino",
    "Фільм {n} ({y}) дивитися онлайн у 1080 якості", "Серіал {n} 1 сезон дивитись онлайн",
    "Мультфільм {n} дивитися онлайн безкоштовно", "{n} — дивитися онлайн українською на uakino.best",
    "{n} ({y}) | Всі серії дивитися онлайн без реєстрації", "{n} сезон 3 серія 9", "{n} 5 серія",
    "Аніме {n} дивитися онлайн усі серії", "«{n}» дивитися онлайн", "{n} ({y}) українською мовою",
    "{n} епізод 4", "{n} у високій якості", "{n} :: Дивитися онлайн", "{n} | UASerials",
]
ru_shapes = [
    "Смотреть {n} в озвучке LostFilm онлайн бесплатно в хорошем качестве", "{n} ({y}) смотреть онлайн",
    "Смотреть мультфильм {n} онлайн бесплатно", "{n} [ТВ-1] смотреть онлайн", "{n} скачать торрент 1080",
    "{n} (ЧБ) в озвучке Дубляж", "{n} (трейлер)", "{n} 1-2 сезон все серии смотреть онлайн",
    "Сериал {n} 3 сезон 5 серия", "{n} скоро", "{n} в 1080 качестве смотреть", "{n} / {en} ({y}) смотреть онлайн бесплатно HDrezka",
    "{n} (+субтитры)", "{n} (режиссёрская версия) смотреть", "{n} (18+) в озвучке HDrezka Studio",
    "Смотреть аниме {n} все серии", "{n} - смотреть онлайн на русском языке", "{n} сезон 2 эпизод 7",
    "{n} (2019) в высоком качестве", "Кино {n} онлайн", "{n} (", "{n} (Mayday", "Смотреть {n} скоро",
    "{n} [TV-2] HD", "{n}\nв озвучке Дубляж", "{n}\rв озвучке Дубляж", "{n} в озвучке Дубляж",
]
urls = [
    "https://flixhub.to/watch/1", "https://rezka.example/series/drama/1-mentalist.html",
    "https://hdrezka.ag/films/fiction/12345-dyuna-2021.html#t:238-s:2-e:3", "https://uakino.best/filmy/genre_comedy/123-name.html",
    "https://uakino.best/seriesss/drama/55-rozryv.html", "https://site.example/series/severance/season-2/episode-4",
    "https://site.example/tv/95396/2/4", "https://kinogo.biz/cartoons/1-name.html", "https://site.example/watch?season=2&episode=7",
    "https://www.youtube.com/watch?v=x", "https://archive.org/details/x", "https://кіно.укр/фільм/дюна",
    "https://a.example/%D1%84%D1%96%D0%BB%D1%8C%D0%BC%D0%B8/1-dune.html", "https://site.example/watch/dune-part-two-19xk2",
    "https://site.example/movie/1234-the-lego-movie.html", "https://site.example/anime/one-piece/episode-1050",
    "https://site.example/mult/123-shrek.html", "https://site.example/serialy/ukr/1-x", "https://site.example/movies/",
    "https://site.example/tv-shows/the-bear?s=2&e=7", "https://site.example/", "https://site.example",
    "https://FlixHub.TO/Watch/Dune", "https://site.example/a b/c", "https://site.example/x%FFy/film",
    "https://www.netflix.com/title/81231974", "https://aniwatch.to/watch/one-piece-100?ep=2142",
    "https://uaserials.pro/1234-rozryv/season-2/episode-4.html", "https://site.example/serial/x/2-sezon/4-seriya",
]
sites = [None, None, "FlixHub", "Netflix", "UAKino", "HDrezka", "YouTube", "Internet Archive", "Kinogo", "Site"]


def year():
    return rng.choice([1984, 1999, 2008, 2014, 2019, 2021, 2024, 2025])


def fill(shape, name):
    en = rng.choice(english)
    return shape.replace("{n}", name).replace("{y}", str(year())).replace("{en}", en)


for shape in en_shapes + uk_shapes + ru_shapes:
    for name in rng.sample(names, 5):
        add("parse", title=fill(shape, name), url=rng.choice(urls), site=rng.choice(sites))
for uk, en in pairs:
    for shape in ["{a} / {b} ({y}) смотреть онлайн", "{a} / {b} — UAKino", "{a} / {b}", "{a} / {b} / {y}", "{a} /{b}"]:
        add("parse", title=shape.replace("{a}", uk).replace("{b}", en).replace("{y}", str(year())), url=rng.choice(urls))

# Other fields and linked data.
for name in rng.sample(names, 25):
    add("parse", title=rng.choice(["Some junk | Site", "", "Site"]), url=rng.choice(urls), og=fill(rng.choice(en_shapes + ru_shapes), name),
        site="Site", ogType=rng.choice([None, "video.movie", "video.tv_show", "video.episode", "website"]),
        ogImage=rng.choice([None, "https://img.example/p.jpg", "/rel/p.jpg", ""]), ogDescription=rng.choice([None, "About it."]))
    add("parse", title="", url=rng.choice(urls), h1=fill(rng.choice(uk_shapes), name), tw=rng.choice([None, fill(rng.choice(en_shapes), name)]))
for name in rng.sample(names, 20):
    ld_type = rng.choice(["Movie", "TVEpisode", "TVSeries", "VideoObject", "Episode", "CreativeWork", "movie series", "TVSeason"])
    add("parse", title=fill(rng.choice(en_shapes), name), url=rng.choice(urls),
        ld=[{"type": ld_type, "name": rng.choice([name, f"  {name} ", "Pilot", ""]), "series": rng.choice([None, name, "  "]),
             "season": rng.choice([None, 1, 2]), "episode": rng.choice([None, 3]), "year": rng.choice([None, 2020]),
             "image": rng.choice([None, "https://img.example/ld.jpg"]), "description": rng.choice([None, "Plot."])},
            {"type": "VideoObject", "name": "Trailer"}])
# Slugs only.
slug_urls = [
    "https://site.example/watch/dune-part-two-19xk2", "https://site.example/movie/1234-the-lego-movie.html",
    "https://site.example/film/straße-der-lieder", "https://site.example/ua/ﬁlm-x", "https://site.example/serial/%E2%85%AB-monkeys",
    "https://site.example/films/18432-dune.html", "https://site.example/watch/ab12cd34", "https://site.example/movies/oppenheimer-2023",
    "https://site.example/v/%D0%B4%D1%8E%D0%BD%D0%B0-2021", "https://site.example/series/the_bear.php", "https://site.example/player/embed",
    "https://site.example/watch/ǆungla", "https://site.example/film/ŉame-x", "https://site.example/w/%2541bc-def",
    "https://site.example/film/a%2Fb-c", "https://site.example/film/x.y.z+w", "https://site.example/ru/index.php",
    "https://site.example/movie/the-lego-movie-2014-hd-online", "https://site.example/film/ⅻ-monkeys",
]
for url in slug_urls:
    add("parse", title="", url=url)
    add("parse", title="Site", url=url, site="Site")

# Odd text.
odd = [
    "", " ", " ", "FlixHub", "| | |", "Дўна", "Дюна́", "—", "«", "«Дюна", "Дюна»", "«Дюна»", "«Дюна» «Друга»",
    "\"\"", "'Dune", "Dune'", "\"Dune", "„Dune“", "Dune: Part Two!!!", "D", "1", "12", "(2024)", "[2024]", "Dune (2024) (2021)",
    "Dune 1999 2024", "Dune 19٢٣", "Dune S٢E٣", "Season ５ Episode ６", "Dune Part Two", "Dune\vPart", "Dune\fPart",
    "Dune\u0085Part", "Ⓐbc 2024", "hd hd hd", "on aniwatch.to", "Dune on aniwatch.to", "Ｄｕｎｅ", "ﬁlm online", "Straße online",
    "Dune​Part", "Dune­Part", "x́ 2024", "́", "Dune ;", "-- Dune --", "~Dune~", "Dune / ", " / Dune", "a / b",
    "Kino.example", "Сериал онлайн", "Фільм", "Movie", "The Movie", "Episode 5", "S01E01", "1x01", "Dune 1x1", "Dune 1x0001",
    "Dune season 2", "Dune 2 season", "Dune сезон 2", "Dune 2-сезон", "Dune серия 10", "Dune 10 серия", "Dune 10-я серия",
]
for text in odd:
    add("parse", title=text, url=rng.choice(urls), site=rng.choice(sites))
    add("clean", text=text, tokens=rng.choice([[], ["flixhub"], ["kinoexample", "kino"]]))

# Episode references and kinds in titles and addresses.
refs = urls + slug_urls + [
    "https://rezka.example/series/drama/1-name-2020.html#t:238-s:2-e:3", "https://x.example/#-s:1-e:12", "https://x.example/?s=3&e=14",
    "https://x.example/watch?ep=2&season=1", "https://x.example/watch?season=1&ep=2", "https://x.example/show/abc/12/345",
    "https://x.example/tv/12/1/2/", "https://x.example/serial/the-x/1/2", "https://x.example/series/x/1/2/3", "S1E1", "s01.e02",
    "1x002", "10x10", "100x10", "сезон 1 серія 2", "1 сезон 2 серія", "Сезон: 3, Серия: 4", "season-1/episode-2", "Season 1 - Ep. 2",
    "season 1 ep 2", "Season 01 Episode 001", "episode 5 season 2", "S1 E1", "s1-e1", "S1_E1", "S1xE1", "x1x02x",
] + [fill(s, "Dune") for s in en_shapes + uk_shapes + ru_shapes]
for text in refs:
    add("ref", text=text)
    add("kind", text=text)

# MARK: Rescue

link_names = ["Dune: Part Two", "Dune", "The Lego Movie", "Scary Movie", "Vanishing Film", "Дюна: Частина друга", "Severance",
              "Головоломка 2", "1917", "Fast & Furious 9", "Amélie", "Ｄｕｎｅ", "Pokémon"]
link_shapes = ["{n} ({y})", "{n}", "Watch {n} Full Movie Online Free ({y})", "Смотреть {n} онлайн бесплатно ({y})", "{n} 2 ({y})",
               "{n} | Official Trailer ({y})", "{n} review", "{n} / {en} ({y})", "{n}\n{y}", "{n} - Extended Cut", "{n} 4K HDR {y}",
               "{n} (1984)", "{n} - {y} - Sci-Fi", "Дивитися {n} українською", "{n} трейлер", "{n}: Prophecy ({y})", "The {n}"]
link_paths = ["/film/{s}", "/films/18432-{s}.html", "/tag/{s}", "/search?q={s}", "/watch/{s}/", "/", "", "/{s}.html", "/a/b.c/",
              "/films/12{s}", "/f/%D0%B4%D1%8E%D0%BD%D0%B0", "/v/{s}?x=1#y"]
link_hosts = ["https://site.example", "https://www.site.example", "https://ads.example", "http://player.site.example", "ftp://site.example"]
for _ in range(220):
    name = rng.choice(link_names)
    slug = rng.choice(["dune-part-two", "dune", "the-lego-movie", "x", "2021-dune", "dune-2", "%D0%B4%D1%8E%D0%BD%D0%B0"])
    url = rng.choice(link_hosts) + rng.choice(link_paths).replace("{s}", slug)
    text = fill(rng.choice(link_shapes), name) if rng.random() < 0.9 else ""
    context = rng.choice(["", "2024 Sci-Fi", "1984", "2023 · 2h 46m", "Дюна 2021"])
    want = rng.sample(link_names, rng.choice([1, 1, 2]))
    add("score", url=url, text=text, context=context, names=want, year=rng.choice([None, 2024, 2021, 2014]))
for _ in range(60):
    links = []
    for _ in range(rng.randint(1, 6)):
        links.append({"url": rng.choice(link_hosts) + rng.choice(link_paths).replace("{s}", rng.choice(["dune", "dune-part-two", "x"])),
                      "text": fill(rng.choice(link_shapes), rng.choice(link_names)), "context": rng.choice(["", "2024", "1984"])})
    add("best", links=links, names=rng.sample(link_names, 1), year=rng.choice([None, 2024, 2021]),
        page=rng.choice([None, "https://site.example/search?q=dune", "https://site.example/film/dune"]))
tokens_texts = names + odd + [l for l in link_shapes] + ["Dune—Part²", "Ａ１ 2024", "ǅungla", "İstanbul", "ß ss", "x²y", "١٢٣ 2024"]
for text in tokens_texts:
    add("tokens", text=text)
for host in ["hdrezka.ag", "rezka-ua.co", "kinogo1.biz", "kinogo.is", "uakino.best", "127.0.0.1", "hd.example", "hdhd.example",
             "hd12345.com", "123.example", "a-b-c.example", "-x.example", ".example", "", "xn--j1agd8g.xn--j1amh", "www.hdrezka.ag",
             "kino-online.example", "player.uakino.me", "hdrezka.co.uk", "HDRezka.AG", "[::1]", "1x2.org"]:
    add("brand", host=host)
mirror_urls = ["https://hdrezka.ag/series/drama/1-mentalist-2008.html#t:238-s:3-e:5", "https://kino-online.example/film/1",
               "https://www.hdrezka.ag/x?y=1", "http://user@hdrezka.ag:8080/x", "https://127.0.0.1/x", "https://uakino.best/film/x"]
for url in mirror_urls:
    add("mirrors", url=url, hosts=["rezka-ua.co", "uakino.me", "hdrezka.ag", "rezka.fi", "rezka-ua.co", "REZKA.ME", "10.0.0.1",
                                   "kino-hd.example", "kino.example", "uakino.club", "www.rezka.cc"])

# MARK: Episode links

link_templates = [
    "https://a.example/serial/rozryv/{s}-sezon/{e}-seriya", "https://a.example/show-s{S}e{E}.html", "https://a.example/show/S{s}E{e}",
    "https://a.example/show/{s}x{E}", "https://a.example/tv/the-bear/season-{s}/episode-{e}", "https://a.example/tv/the-bear/season/{s}/episode/{e}",
    "https://a.example/watch?season={s}&episode={e}", "https://a.example/watch?s={s}&e={e}",
    "https://rezka.example/series/drama/1-mentalist-2008.html#t:238-s:{s}-e:{e}", "https://a.example/show/episode-{e}",
    "https://a.example/film/part-2-2021", "https://s2e4.example/film", "https://a.example/{e}-seriya", "https://a.example/ep{e}",
    "https://a.example/sezon-{s}-seriya-{e}", "https://a.example/2-season-{e}-episode", "https://a.example/серія-{e}/епізод",
    "https://a.example/фільм/s{S}e{E}", "https://кіно.укр/s{S}e{E}", "https://a.example/x?ep={e}", "https://a.example/s{s}.e{E}/",
    "https://a.example/s{s}_e{e}_x", "https://a.example/{s}x{e}x{e}", "https://a.example/seriya/{e}", "https://a.example/episodes/{e}",
]
for template in link_templates:
    for _ in range(4):
        s, e = rng.randint(1, 12), rng.randint(1, 24)
        url = template.replace("{S}", f"{s:02d}").replace("{E}", f"{e:02d}").replace("{s}", str(s)).replace("{e}", str(e))
        cs, ce = rng.choice([(s, e), (s, e), (s, e + 1), (1, 1)])
        ts, te = rng.choice([(cs, ce + 1), (cs + 1, 1), (cs, ce + 90), (cs, 9)])
        add("links", url=url, current=[cs, ce], target=[ts, te])

# MARK: Metadata

hit_names = ["Dune", "Dune: Part Two", "Dune Part Two", "Dune 2", "Дюна", "The Lego Movie", "Lego", "Severance", "Amélie", "1917", ""]
for _ in range(150):
    hits = []
    for i in range(rng.randint(0, 5)):
        hits.append({"id": f"tt{rng.randint(1, 99999):07d}", "name": rng.choice(hit_names), "year": rng.choice([None, 2020, 2021, 2022, 2024]),
                     "kind": rng.choice(["film", "series", "cartoon", "unknown"]), "rank": rng.choice([None, 1, 499, 500, 3000, 9000, 100000])})
    add("match", hits=hits, name=rng.choice(hit_names + ["Дюна: Частина друга", "^_^", "Ｄｕｎｅ", "ǅ"]),
        year=rng.choice([None, 2021, 2024]), kind=rng.choice(["film", "series", "cartoon", "unknown"]))
for raw in [None, "https://m.media-amazon.com/images/M/MV5B._V1_.jpg", "https://m.media-amazon.com/images/M/MV5B._V1_QL75_.jpg",
            "https://img.example/a b.jpg", "", "/rel.jpg", "https://img.example/._V1_._V1_.png"]:
    add("poster", raw=raw)
for query in ["Dune", " d ", "a", "Дюна: Частина друга", "AC/DC", "100% Wolf", "İstanbul", "ß", "x́", "  ", "a b?c#d", "Ｄｕｎｅ", "Æon"]:
    add("searchurl", query=query)

search_bodies = [
    {"d": [{"i": {"height": 1, "imageUrl": "https://m.media-amazon.com/images/M/MV5B._V1_.jpg", "width": 1}, "id": "tt15239678",
            "l": "Dune: Part Two", "q": "feature", "qid": "movie", "rank": 15, "s": "Timothée Chalamet, Zendaya", "y": 2024},
           {"id": "nm0000001", "l": "Someone", "s": "Actor"},
           {"id": "tt0001", "l": "A Series", "qid": "tvSeries", "y": 2020.0, "rank": 1e3},
           {"id": "tt0002", "l": "A Game", "qid": "videoGame", "y": 2020},
           {"id": "tt0003", "qid": "movie"},
           {"id": "tt0004", "l": "Mini", "qid": "tvMiniSeries", "i": None, "y": None},
           {"id": "tt0005", "l": "Special", "qid": "tvSpecial", "i": {"imageUrl": None}}], "q": "dune", "v": 1},
    {"d": []},
    {"q": "x"},
    {"d": [{"l": "No id", "qid": "movie"}]},
    {"d": [{"id": "tt1", "l": "Bad year", "qid": "movie", "y": "2024"}]},
    {"d": [{"id": "tt1", "l": "Half year", "qid": "movie", "y": 2024.5}]},
    {"d": [{"id": "tt1", "l": "Image string", "qid": "movie", "i": "x"}]},
    {"d": None},
    [],
]
for body in search_bodies:
    add("search", body=json.dumps(body, ensure_ascii=False))
add("search", body="not json")

detail_bodies = [
    {"meta": {"description": "Paul Atreides unites with Chani.", "genres": ["Action", "Sci-Fi"], "runtime": "166 min",
              "poster": "https://images.metahub.space/poster/medium/tt15239678/img", "background": "https://images.metahub.space/background/medium/tt15239678/img",
              "releaseInfo": "2024", "videos": []}},
    {"meta": {"genres": ["Animation"], "runtime": "2h 46min", "releaseInfo": "2008–2013", "videos": [
        {"name": "Pilot", "season": 1, "episode": 1, "released": "2008-01-20T05:00:00.000Z", "thumbnail": "https://t.example/1.jpg", "overview": "First."},
        {"name": "Second", "season": 1, "number": 2, "released": "2008-01-27T05:00:00.000Z", "description": "Desc."},
        {"name": "Special", "season": 0, "episode": 1, "released": "2009-01-01T00:00:00.000Z"},
        {"name": "No number", "season": 2},
        {"name": "S2E1", "season": 2, "episode": 1, "number": 9, "released": "2009-03-08T00:00:00Z"},
        {"name": "S1E3", "season": 1, "episode": 3, "released": "2008-02-03T05:00:00.5+02:00"},
        {"name": "Dup", "season": 1, "episode": 3, "released": None},
        {"name": "Later", "season": 1, "episode": 10, "released": "2019-02-30T00:00:00.000Z"}]}},
    {"meta": None},
    {},
    {"meta": {"genres": ["Drama", 3]}},
    {"meta": {"runtime": 120}},
    {"meta": {"runtime": "١٢٠ min", "releaseInfo": "20"}},
    {"meta": {"runtime": "", "releaseInfo": "-201", "videos": [{"season": "1", "episode": 1}]}},
    {"meta": {"runtime": "½h", "releaseInfo": "２０２４"}},
    {"meta": {"videos": None, "genres": None, "poster": "", "background": "/rel.jpg"}},
]
for body in detail_bodies:
    add("detail", body=json.dumps(body, ensure_ascii=False))
for date in ["2019-01-01T00:00:00.000Z", "2019-01-01T00:00:00.123456Z", "2019-01-01T00:00:00.1+0200", "2019-01-01t00:00:00.000z",
             "2019-01-01T00:00:00.000", "2019-01-01 00:00:00.000Z", "2019-1-01T00:00:00.000Z", "2019-01-01T24:00:00.000Z",
             "2019-02-30T00:00:00.000Z", "2019-01-01T00:00:60.000Z", "2019-01-01T00:00:00.000+02", "2019-01-01T00:00:00.000+02:30",
             "2019-01-01T00:00:00.000-00:00", "2019-01-01T00:00:00.Z", " 2019-01-01T00:00:00.000Z", "2019-01-01T00:00:00,5Z",
             "2019-01-01T00:00:00Z", "2024-02-29T23:59:59.999Z", "2023-02-29T12:00:00.000Z", "2019-01-01T00:00:00.000-05:00"]:
    add("date", text=date)
previews = [
    ('<head><meta content="https://cdn.example/poster.jpg" property="og:image"><meta property="og:description" content="A film &amp; more"></head>', "https://site.example/x"),
    ('<meta property="og:image" content="/i/p.jpg">', "https://site.example/film/x"),
    ('<meta property="og:image" content="/static/logo.png">', "https://site.example/x"),
    ('<meta property="og:image" content="//cdn.example/a.svg">', "https://site.example/x"),
    ('<META PROPERTY=\'og:image\' CONTENT=\'p.jpg?a=1&amp;b=2\'>', "https://site.example/dir/page.html"),
    ('<meta name="description" content="x"><meta property="og:description" content="&quot;Quoted&quot; &#39;s">', "https://site.example/"),
    ('<meta property="og:image" content="../up/p a.jpg">', "https://site.example/a/b/c"),
    ('<meta property="og:image" content="https://cdn.example/Logos/x.jpg">', "https://site.example/"),
    ('<meta property="og:imagex" content="https://cdn.example/x.jpg">', "https://site.example/"),
    ('<meta property="og:image" content="https://cdn.example/фото.jpg">', "https://кіно.укр/x"),
    ('', "https://site.example/"),
]
for html, base in previews:
    add("preview", html=html, base=base)

# MARK: Addresses, as Foundation reads them

url_texts = urls + slug_urls + mirror_urls + [
    "https://a.example/a%20b c", "https://a.example/a%20b/фільм", "https://a.example/a%20b?q=ф", "https://a.example/a b?q=%20",
    "https://a.example/%D1%84 x", "https://a.example/x%20#ф%20", "https://a.example/x%20", "https://a.example/a%zz%20",
    "https://a.example/a%20?q=%20#%20 ", "https://u%20@a.example/ф", "https://a.example/a%2", "https://a.example/a%20%",
    "https://a.example/a|b%20", "https://a.example/a^b%20", "https://a.example/a\"b%20", "https://a.example/a%20[b]",
    "https://a.example/a{b}%20", "https://a.example/a%20#a#b", "https://a.example/a b#%20", "https://a.example/ф?%20",
    "https://a.example/a%FFb/c", "https://a.example///", "https:///x", "http://[::1]:80/a", "http://u:p@A.Example:8080/x",
    "https://a.example/b.", "https://a.example/a..b", "https://a.example/.b.c", "https://a.example/b.tar.gz",
    "https://a.example/x/%2F", "https://a.example/x%2Fy.html", "https://a.example/ b", "relative/path.html",
    "https://a.example/a%20b.html", "https://a.example/-.html", "https://a.example/.", "https://a.example/..html",
    "https://a.example/a/b.c/", "mailto:x@y.z", "https://a.example?x=1", "https://a.example#f", "https://кіно.укр/фільм",
    "https://a.example/x/a.b%20c", "https://a.example/x/...html", "https://a.example/x/a.%20", "https://a.example/x/a.%FF",
    "https://a.example/x/%FF.html", "https://@/x", "https://:80/x", "https://a.example:/x", "https://A%41.example/x",
    "https://a%FF.example/x", "https://user@a.example/x", "https://a.example/x?a=1&b=2#t:1-s:2-e:3", "//a.example/x", "/x/y.html",
]
for text in url_texts:
    add("url", text=text)

# MARK: Fuzz: titles glued together from the pieces the patterns care about.

pieces = [
    "Dune", "Part", "Two", "the", "Movie", "Film", "фільм", "фильм", "Дюна", "Частина", "друга", "Їжак", "ґ", "й", "Ё",
    "watch", "WATCH", "Online", "free", "HD", "4K", "1080p", "720", "hdrip", "web-dl", "full movie", "смотреть", "онлайн",
    "дивитися", "безкоштовно", "в хорошем качестве", "у хорошій якості", "в озвучке", "озвучка", "в 1080 качестве", "у 720 якості",
    "скачать", "скачати", "торрент", "торренты", "скоро", "coming soon", "english sub", "sub/dub", "on site.to", "on x", "(", ")",
    "[", "]", "[ТВ-2]", "[TV]", "(трейлер)", "(чб)", "(18+)", "(+субтитры)", "«", "»", "\"", "“", "”", "„", "'", "|", " | ", " - ",
    " – ", " — ", " : ", ":", " :: ", " • ", " · ", " » ", " « ", " ~ ", " / ", "/", "1984", "2021", "(2024)", "[2019]", "2049", "1899",
    "2050", "19", "S01E02", "s1e2", "S1 E2", "2x03", "12x123", "season 2", "Season 3 Episode 4", "сезон 2", "2 сезон", "3 серія",
    "серия 4", "епізод 5", "эпизод 6", "episode 7", "ep 8", "-", "–", ".", ",", ";", "!", "?", "  ", "\t", " ", " ",
    "​", "́", "̆", "é", "й", "ß", "Ⅱ", "²", "½", "٣", "５", "Ａ", "x", "1", "22", "333", "4444",
]
for _ in range(900 * scale):
    text = "".join(rng.choice(pieces) + rng.choice(["", " ", " ", " "]) for _ in range(rng.randint(1, 9)))
    add("parse", title=text, url=rng.choice(urls), site=rng.choice(sites))
for _ in range(300 * scale):
    text = "".join(rng.choice(pieces) + rng.choice(["", " "]) for _ in range(rng.randint(1, 7)))
    add("clean", text=text, tokens=rng.choice([[], ["dune"], ["site"]]))
    add("ref", text=text)
for _ in range(300 * scale):
    text = "".join(rng.choice(pieces) + rng.choice(["", " "]) for _ in range(rng.randint(0, 7)))
    name = "".join(rng.choice(pieces) + " " for _ in range(rng.randint(1, 3))).strip()
    add("score", url=rng.choice(link_hosts) + rng.choice(link_paths).replace("{s}", rng.choice(["dune", "2-x", "a.b", "%D0%B4"])),
        text=text, context=rng.choice(["", "2021", "1984 2024"]), names=[name, "Dune"], year=rng.choice([None, 2021, 2024]))
url_pieces = ["/", "-", "_", ".", "s", "e", "x", "S", "E", "1", "02", "3", "10", "sezon", "seriya", "season", "episode", "ep", "?",
              "&", "=", "#", "t:1-", "s:", "-e:", "serial", "html", "a", "%20", "серія", "%", "%zz", "|", " ", "ф"]
for _ in range(300 * scale):
    path = "".join(rng.choice(url_pieces) for _ in range(rng.randint(3, 14)))
    s, e = rng.randint(0, 3), rng.randint(0, 12)
    add("links", url="https://a.example/" + path, current=[s, e], target=rng.choice([[s, e + 1], [s + 1, 1], [s, 100]]))
    add("ref", text="https://a.example/" + path)

path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus.jsonl")
with open(path, "w", encoding="utf-8") as f:
    for item in out:
        f.write(json.dumps(item, ensure_ascii=False) + "\n")
print(len(out), "cases")
