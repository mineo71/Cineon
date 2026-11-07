// The downloads' words: the Mac's, with Mac words swapped for browser ones. "this Mac" is "this
// computer". The browser can't move files to the Bin (chrome.downloads.removeFile deletes them for
// good), so the Bin's copy says so instead of promising a way back.

export const DownloadText = {
  thisComputer: "this computer",

  playFirst: "Play the video for a moment first, so Cineon can see its file",
  alreadyDownloading: (name: string) => `${name} is already downloading`,
  queued: (fileName: string) => `Queued ${fileName}, after the ones running now`,
  downloading: (fileName: string) => `Downloading ${fileName}`,
  saved: (fileName: string) => `Saved ${fileName}`,
  play: "Play",

  /** The Mac's "Moved X to the Bin, since you've watched it". */
  deletedWatched: (fileName: string) => `Deleted ${fileName}, since you've watched it`,

  /** Menu item for a finished download (Mac: "Move to Bin"); "Remove" for the rest. */
  deleteFile: "Delete File",
  remove: "Remove",
  /** New: deleting can't be undone in the browser, so the UI asks first. */
  confirmDelete: (fileName: string) =>
    `Delete ${fileName} from your Downloads folder? The browser can't move it to the Bin, so it can't be put back.`,
  confirmDeleteButton: "Delete",

  /** Settings toggle (Mac: "Bin episodes once watched", `binWatchedDownloads`). */
  binSettingTitle: "Delete episodes once watched",
  binSettingDetail:
    "A downloaded episode you watched to the end is deleted from your Downloads folder when you move on, to save space. The browser can't move it to the Bin, so it can't be put back.",

  /** Under a series' size estimate: what the free-space figure measures. */
  freeSpaceNote:
    "Free space is the room the browser gives Cineon on this computer. The browser doesn't say how much is left in your Downloads folder.",

  // SeasonGrabber
  openAnEpisode: "Open an episode of the series first",
  stillLooking: "Still looking for the episodes",
  alreadyGetting: (label: string) => `Already getting ${label}`,
  lookingForEvery: (name: string) => `Looking for every episode of ${name}…`,
  noSeasonEpisodes: "Cineon couldn't find this season's episodes",
  seasonAlreadyHere: "Every episode of this season is already on this computer",
  noSeriesEpisodes: (name: string) => `Cineon couldn't find the episodes of ${name}`,
  seriesAlreadyHere: (name: string) => `Every episode of ${name} is already on this computer`,
  getting: (count: number, label: string) => `Getting ${count} episode${count === 1 ? "" : "s"} of ${label}`,
  carryingOn: (label: string, left: number) => `Carrying on with ${label}: ${left} to go`,
  stoppedGetting: (label: string) => `Stopped getting ${label}`,
  allDownloading: (count: number, label: string) => `All ${count} episodes of ${label} are downloading`,
  someMissed: (queued: number, total: number, missed: string) =>
    `Queued ${queued} of ${total}. Couldn't find the file for ${missed}`,
  jobStoppedWhenClosed: (label: string) => `Getting ${label} stopped when Cineon closed`,
  carryOn: "Carry on",
};
