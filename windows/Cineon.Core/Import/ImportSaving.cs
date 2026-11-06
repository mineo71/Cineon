using Cineon.Core.Data;

namespace Cineon.Core.Import;

// Port of the LibraryStore and Database extensions at the bottom of Cineon/Core/BrowserImport.swift.

public static class LibraryStoreImport
{
    extension(LibraryStore library)
    {
        /// <summary>
        /// Writes everything in one transaction. Importing the same browser twice adds nothing new,
        /// and never overwrites a real saved position with a page visit.
        /// </summary>
        public ImportResult ApplyImport(ImportSelection selection)
        {
            var result = new ImportResult();
            var db = library.Db;

            foreach (var candidate in selection.Sites)
            {
                if (library.SiteForHost(candidate.Host) is not null) continue;
                if (library.AddSite(candidate.HomeUrl) is not null) result.Sites++;
            }

            try
            {
                db.Sql.Transaction(() =>
                {
                    foreach (var (candidate, status) in selection.Titles)
                    {
                        var existing = library.Find(candidate.Name, candidate.AltName, candidate.Year);
                        if (existing is null)
                        {
                            // The catalogue may have renamed it since ("Дюна" is now "Dune"), so the page's
                            // address is the better way to recognise something imported before.
                            foreach (var visit in candidate.Visits)
                            {
                                if (db.Progress(UrlKey.Make(visit.Url)) is { } known && library.Titles.TryGetValue(known.TitleId, out var title))
                                {
                                    existing = title;
                                    break;
                                }
                            }
                        }
                        long id;
                        if (existing is not null)
                        {
                            id = existing.Id;
                        }
                        else
                        {
                            var date = candidate.LastVisit == DateTimeOffset.MinValue ? DateTimeOffset.UtcNow : candidate.LastVisit;
                            var title = new Title
                            {
                                Id = 0, Name = candidate.Name, NormName = LibraryText.Normalize(candidate.Name), Year = candidate.Year,
                                Kind = candidate.Kind, Status = status, ImdbId = null, PosterUrl = null, BackdropUrl = null, Overview = null,
                                Genres = [], RuntimeMinutes = null, RatingHalves = null, Notes = null, AddedAt = date, UpdatedAt = date,
                                FinishedAt = status == TitleStatus.Watched ? date : null,
                                LastWatchedAt = status == TitleStatus.Backlog ? null : date,
                                MetadataChecked = false,
                            };
                            id = db.InsertTitle(title);
                            result.NewTitleIds.Add((id, candidate.AltName));
                            result.Titles++;
                        }
                        foreach (var visit in candidate.Visits) Record(db, visit, id, status);
                    }
                    foreach (var page in selection.Pages)
                    {
                        if (db.ImportHistory(page)) result.Pages++;
                    }
                });
            }
            catch (SqlError)
            {
            }
            library.Reload();
            return result;
        }
    }

    private static void Record(Database db, ImportVisit visit, long titleId, TitleStatus status)
    {
        // A backlog entry was never watched, so it has no place on the timeline.
        // Nor does a tab with no known date, which would sort oddly.
        if (status != TitleStatus.Backlog && visit.Date != DateTimeOffset.MinValue && !db.HasSession(titleId, visit.Ref, visit.Date))
        {
            db.InsertSession(new WatchSession
            {
                Id = 0, TitleId = titleId, Ref = visit.Ref, EpisodeName = null, Url = visit.Url, Host = visit.Host,
                StartedAt = visit.Date, EndedAt = visit.Date, WatchedSeconds = 0, StartPosition = 0, EndPosition = 0,
                Duration = 0, Finished = false,
            });
        }
        if (db.Progress(titleId, visit.Ref) is null)
        {
            db.UpsertProgress(new WatchProgress
            {
                TitleId = titleId, Ref = visit.Ref, UrlKey = UrlKey.Make(visit.Url), Url = visit.Url, Host = visit.Host,
                Position = 0, Duration = 0, Finished = false,
                UpdatedAt = visit.Date == DateTimeOffset.MinValue ? DateTimeOffset.UtcNow : visit.Date,
            });
        }
    }
}

public static class DatabaseImport
{
    extension(Database db)
    {
        /// <summary>Returns true if the page wasn't already there. Seeks on the time index, so it stays fast.</summary>
        public bool ImportHistory(BrowsedPage page)
        {
            var url = page.Url.OriginalString;
            var exists = db.Sql.Query("SELECT 1 FROM history WHERE visited_at=? AND url=? LIMIT 1", [page.LastVisit, url], _ => true).Count > 0;
            if (exists) return false;
            db.Sql.Run(
                "INSERT INTO history(url,host,title,visited_at) VALUES(?,?,?,?)",
                url, SwiftUrl.Host(page.Url) ?? "", page.Title, page.LastVisit);
            return true;
        }

        public bool HasSession(long titleId, EpisodeRef episode, DateTimeOffset startedAt) =>
            db.Sql.Query(
                "SELECT 1 FROM sessions WHERE title_id=? AND season=? AND episode=? AND started_at=? LIMIT 1",
                [titleId, episode.Season, episode.Episode, startedAt], _ => true).Count > 0;
    }
}
