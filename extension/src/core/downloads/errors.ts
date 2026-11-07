// Port of windows/Cineon.Core/Downloads/DownloadHttp.cs (the errors), with the browser's own
// download interruptions (chrome.downloads InterruptReason) worded the way the Mac words failures.

/** The site answered with an HTTP error. */
export class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(DownloadErrors.explain(status));
    this.name = "DownloadHttpError";
  }
}

/** A download that can't go on, with the message the Downloads page shows. */
export class DownloadFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadFailedError";
  }
}

/** No data arrived for the idle timeout (the Mac's `timeoutIntervalForRequest`, 60 s). */
export class DownloadTimeoutError extends Error {
  constructor() {
    super(DownloadErrors.timedOut);
    this.name = "DownloadTimeoutError";
  }
}

/**
 * The network failed: `connect` before any answer (fetch's TypeError), `lost` while the body was
 * arriving. fetch can't tell an unknown host from a refused connection, so both are `connect`.
 */
export class DownloadNetworkError extends Error {
  constructor(readonly stage: "connect" | "lost") {
    super(stage === "connect" ? DownloadErrors.cannotConnect : DownloadErrors.connectionLost);
    this.name = "DownloadNetworkError";
  }
}

/** The person stopped it (an aborted signal). */
export class DownloadStoppedError extends Error {
  constructor() {
    super(DownloadErrors.stopped);
    this.name = "DownloadStoppedError";
  }
}

/** The folder inside the browser's downloads folder where everything is saved. */
const FOLDER = "Cineon";

export const DownloadErrors = {
  protected: "The stream couldn't be saved. It may be protected.",
  separateAudio: "The stream keeps its sound apart from the picture, which Cineon can't save as one file yet.",
  timedOut: "The request timed out.",
  connectionLost: "The network connection was lost.",
  cannotFindHost: "A server with the specified hostname could not be found.",
  cannotConnect: "Could not connect to the server.",
  secureConnectionFailed: "An SSL error has occurred and a secure connection to the server cannot be made.",
  /** A server error whose status the browser doesn't tell. */
  serverError: "The site answered with an error.",
  stopped: "Stopped",
  stoppedWhenClosed: "Stopped when Cineon closed",

  /** What an HTTP error means for the person downloading. 401 and 403 are a refusal. */
  explain(status: number): string {
    if (status === 401 || status === 403) {
      return "The site refused. The link may have expired: open the page and download again.";
    }
    if (status === 404 || status === 410) return "The file is gone from the site.";
    return `The site answered with an error (${status}).`;
  },

  /** "Couldn't save into Cineon: …", the apps' words when the file can't be put in place. */
  couldNotSave(reason: string, folder: string = FOLDER): string {
    return `Couldn't save into ${folder}: ${reason}`;
  },

  /** An error as the Mac words it (Foundation's `localizedDescription` for network failures). */
  describe(error: unknown): string {
    if (error instanceof DownloadHttpError || error instanceof DownloadFailedError) return error.message;
    if (error instanceof DownloadTimeoutError) return DownloadErrors.timedOut;
    if (error instanceof DownloadNetworkError) return error.message;
    if (error instanceof DownloadStoppedError || isAbort(error)) return DownloadErrors.stopped;
    // fetch's own failure: nothing answered.
    if (error instanceof TypeError) return DownloadErrors.cannotConnect;
    if (error instanceof Error) return error.message;
    return String(error);
  },

  /** Worth trying again: the network, a timeout, or a server that's busy rather than refusing. */
  isTransient(error: unknown): boolean {
    if (error instanceof DownloadHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
    if (error instanceof DownloadFailedError || error instanceof DownloadStoppedError || isAbort(error)) return false;
    return error instanceof DownloadTimeoutError || error instanceof DownloadNetworkError || error instanceof TypeError;
  },

  /**
   * Why the browser's download stopped (`chrome.downloads` `InterruptReason`), in the apps' words.
   * `SERVER_FAILED` doesn't carry the status: the center asks the site once more for it, then falls
   * back to `serverError`.
   */
  interruption(reason: string | null | undefined): string {
    switch (reason) {
      case "SERVER_UNAUTHORIZED":
        return DownloadErrors.explain(401);
      case "SERVER_FORBIDDEN":
      case "SERVER_CROSS_ORIGIN_REDIRECT":
        return DownloadErrors.explain(403);
      case "SERVER_BAD_CONTENT":
        return DownloadErrors.explain(404);
      case "SERVER_FAILED":
      case "SERVER_NO_RANGE":
      case "NETWORK_INVALID_REQUEST":
        return DownloadErrors.serverError;
      case "NETWORK_TIMEOUT":
        return DownloadErrors.timedOut;
      case "NETWORK_FAILED":
      case "NETWORK_DISCONNECTED":
      case "SERVER_CONTENT_LENGTH_MISMATCH":
        return DownloadErrors.connectionLost;
      case "NETWORK_SERVER_DOWN":
        return DownloadErrors.cannotConnect;
      case "SERVER_UNREACHABLE":
        return DownloadErrors.cannotFindHost;
      case "SERVER_CERT_PROBLEM":
        return DownloadErrors.secureConnectionFailed;
      case "USER_CANCELED":
        return DownloadErrors.stopped;
      case "USER_SHUTDOWN":
      case "CRASH":
        return DownloadErrors.stoppedWhenClosed;
      case "FILE_NO_SPACE":
      case "FILE_TOO_LARGE":
        return DownloadErrors.couldNotSave("there isn't enough room on the disk.");
      case "FILE_ACCESS_DENIED":
        return DownloadErrors.couldNotSave("the browser isn't allowed to write there.");
      case "FILE_NAME_TOO_LONG":
        return DownloadErrors.couldNotSave("the name is too long.");
      case "FILE_VIRUS_INFECTED":
      case "FILE_BLOCKED":
      case "FILE_SECURITY_CHECK_FAILED":
        return DownloadErrors.couldNotSave("the browser blocked the file.");
      default:
        if (reason?.startsWith("FILE_")) return DownloadErrors.couldNotSave("the file couldn't be written.");
        return reason ? `The download was interrupted (${reason}).` : DownloadErrors.stopped;
    }
  },
};

export function isAbort(error: unknown): boolean {
  return (
    error instanceof DownloadStoppedError ||
    (typeof error === "object" && error != null && (error as { name?: unknown }).name === "AbortError")
  );
}
