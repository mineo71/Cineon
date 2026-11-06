using Cineon.Core.Data;

namespace Cineon.App.UI;

/// How episodes are named on screen. The `EpisodeRef` extension at the end of the Mac's Theme.swift.
public static class EpisodeRefLabels
{
    extension(EpisodeRef episode)
    {
        /// "Season 2, episode 5".
        public string LongLabel => $"Season {episode.Season}, episode {episode.Episode}";

        /// "S2 E5".
        public string ShortLabel => $"S{episode.Season} E{episode.Episode}";
    }
}
