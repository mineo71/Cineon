// Which keys to name: ⌘ on a Mac, Ctrl elsewhere.

export function isMac(): boolean {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const platform = (nav as { userAgentData?: { platform?: string } } | null)?.userAgentData?.platform ?? nav?.platform ?? "";
  return /mac/i.test(platform);
}

/** "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function shortcut(key: string, shift = false): string {
  if (isMac()) return `${shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

/** The command key held: ⌘ on a Mac, Ctrl elsewhere. */
export function hasCommand(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
