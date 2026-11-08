// @vitest-environment jsdom
import { installRedirectShield } from "../../src/content/redirectShield";

/** The Navigation API's navigate event, as Chrome fires it (jsdom has no Navigation API). */
function fakeWindow(active = false) {
  const navigation = new EventTarget();
  const win = { navigation, navigator: { userActivation: { isActive: active } } } as unknown as Window;
  const navigate = (url: string, { cancelable = true, ...init }: Record<string, unknown> = {}) => {
    const event = new Event("navigate", { cancelable: cancelable !== false });
    Object.assign(event, {
      destination: { url, sameDocument: false },
      navigationType: "push",
      userInitiated: false,
      hashChange: false,
      formData: null,
      downloadRequest: null,
      ...init,
    });
    navigation.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { win, navigate, activation: win.navigator as unknown as { userActivation: { isActive: boolean } } };
}

describe("the redirect shield", () => {
  test("a script sending a shielded page to another site is stopped before it leaves, and reported", () => {
    // A dead ad host never commits, so the background's check after the fact never sees it; this does.
    const { win, navigate } = fakeWindow();
    const reported: string[] = [];
    installRedirectShield(win, () => "flixdemo.example", (url) => reported.push(url));
    expect(navigate("http://ads.example.test/landing")).toBe(true);
    expect(navigate("https://other.example/x", { navigationType: "replace" })).toBe(true);
    expect(reported).toEqual(["http://ads.example.test/landing", "https://other.example/x"]);
  });

  test("what the person does, the same site, and pages without a stake go through", () => {
    const { win, navigate, activation } = fakeWindow();
    let site: string | null = "flixdemo.example";
    const reported: string[] = [];
    installRedirectShield(win, () => site, (url) => reported.push(url));
    expect(navigate("https://ads.example/x", { userInitiated: true })).toBe(false);
    expect(navigate("https://cdn.flixdemo.example/next")).toBe(false);
    expect(navigate("https://flixdemo.example/next")).toBe(false);
    expect(navigate("https://ads.example/x", { destination: { url: "https://flixdemo.example/#t", sameDocument: true } })).toBe(false);
    expect(navigate("https://ads.example/x", { navigationType: "reload" })).toBe(false);
    expect(navigate("https://ads.example/x", { navigationType: "traverse", cancelable: false })).toBe(false);
    expect(navigate("mailto:someone@example.com")).toBe(false);
    // A click handler that moves the page has the person's activation, as Chrome's client_redirect rule.
    activation.userActivation.isActive = true;
    expect(navigate("https://ads.example/x")).toBe(false);
    activation.userActivation.isActive = false;
    site = null;
    expect(navigate("https://ads.example/x")).toBe(false);
    expect(reported).toEqual([]);
  });

  test("without the Navigation API nothing is installed (the background still sends a committed redirect back)", () => {
    expect(() => installRedirectShield({ navigator: {} } as unknown as Window, () => "a.example", () => undefined)).not.toThrow();
  });
});
