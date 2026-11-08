// The redirect shield in the page, before the page leaves: the Mac cancels a script's navigation to
// another site in its navigation delegate. The background can only act on a navigation the browser
// has committed (it sends the tab back), and a redirect to a host that doesn't answer never commits:
// the tab was left on the browser's error page. The Navigation API's `navigate` event comes first,
// in this (isolated) world too, says whether the person started the navigation, and can cancel it.
//
// The top frame only. `site()` is the page's registrable domain while the background says its
// redirects are shielded (the person's site or a page with a film, the setting on, not allowed for
// the site), else null.

interface NavigateEventLike extends Event {
  readonly destination: { readonly url: string; readonly sameDocument: boolean };
  readonly navigationType: string;
  readonly userInitiated: boolean;
}

export function installRedirectShield(win: Window, site: () => string | null, report: (url: string) => void): void {
  const navigation = (win as unknown as { navigation?: EventTarget }).navigation;
  if (!navigation || typeof navigation.addEventListener !== "function") return;
  navigation.addEventListener("navigate", (raw) => {
    const event = raw as NavigateEventLike;
    const shielded = site();
    if (!shielded || !event.cancelable || event.userInitiated || event.destination?.sameDocument !== false) return;
    if (event.navigationType !== "push" && event.navigationType !== "replace") return;
    // A script moving the page from a click the person just made isn't a redirect: Chrome doesn't mark
    // it `client_redirect` either, which is what the background goes by.
    if ((win.navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive) return;
    let host: string;
    try {
      const url = new URL(event.destination.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      host = url.hostname.toLowerCase();
    } catch {
      return;
    }
    if (host === shielded || host.endsWith(`.${shielded}`)) return;
    event.preventDefault();
    report(event.destination.url);
  });
}
