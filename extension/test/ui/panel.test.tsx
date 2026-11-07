// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { MemoryStorage } from "../../src/core/data";
import { AppModel } from "../../src/ui/lib/app";
import { Page } from "../../src/ui/lib/hooks";
import { rateQueue } from "../../src/ui/lib/library";
import { makeLive } from "../../src/ui/lib/live";
import { Session } from "../../src/ui/lib/session";
import { setTransport } from "../../src/shared/messages";
import { QuickRating } from "../../src/ui/screens/PanelRating";

let session: Session | null = null;

beforeEach(() => {
  // No background in tests.
  setTransport(null);
});

afterEach(() => {
  cleanup();
  session?.close();
  session = null;
  setTransport(undefined);
});

async function openWith(names: string[]): Promise<Session> {
  session = await Session.open(null, { storage: new MemoryStorage(), metadata: false });
  for (const name of names) await session.library.addTitle(name, { status: "watched", kind: "film", year: 2001 });
  return session;
}

/** The film the card is asking about. */
function currentName(): string | null {
  return document.querySelector(".panel-rate-name")?.textContent ?? null;
}

function renderPanel(s: Session) {
  const model = new AppModel(s);
  const live = makeLive(s.channel, () => s.db);
  return render(
    <Page.Provider value={{ model, live }}>
      <QuickRating />
    </Page.Provider>,
  );
}

describe("QuickRating", () => {
  it("rates the current film with a digit and moves on", async () => {
    const s = await openWith(["Amélie", "Brazil"]);
    const [firstId, secondId] = rateQueue(s.library.titles.values(), false);
    const first = s.library.titles.get(firstId!)!;
    const second = s.library.titles.get(secondId!)!;
    renderPanel(s);

    expect(currentName()).toBe(first.name);
    expect(screen.getByText("2 waiting")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "8" });
    await waitFor(() => expect(s.library.titles.get(first.id)!.ratingHalves).toBe(16));
    await waitFor(() => expect(currentName()).toBe(second.name), { timeout: 2000 });
    expect(screen.getByText("1 waiting")).toBeTruthy();
  });

  it("nudges with the arrows, clears with Delete and skips with Return", async () => {
    const s = await openWith(["Amélie", "Brazil"]);
    const [firstId, secondId] = rateQueue(s.library.titles.values(), false);
    renderPanel(s);

    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => expect(s.library.titles.get(firstId!)!.ratingHalves).toBe(11));
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(s.library.titles.get(firstId!)!.ratingHalves).toBeNull());
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(currentName()).toBe(s.library.titles.get(secondId!)!.name));
  });

  it("leaves typing alone", async () => {
    const s = await openWith(["Amélie"]);
    const [firstId] = rateQueue(s.library.titles.values(), false);
    renderPanel(s);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "7" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.library.titles.get(firstId!)!.ratingHalves).toBeNull();
    input.remove();
  });

  it("says when everything has its stars", async () => {
    const s = await openWith([]);
    renderPanel(s);
    expect(screen.getByText("Everything you've watched has its stars.")).toBeTruthy();
  });
});
