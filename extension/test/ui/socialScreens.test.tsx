// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/core/data";
import { SignalChannel, setTransport } from "../../src/shared/messages";
import { MenuLayer } from "../../src/ui/components/menu";
import { confirmDialog } from "../../src/ui/components/confirm";
import { AppModel } from "../../src/ui/lib/app";
import { Page } from "../../src/ui/lib/hooks";
import { makeLive } from "../../src/ui/lib/live";
import { Session } from "../../src/ui/lib/session";
import { ProfilePicker } from "../../src/ui/screens/ProfilePicker";
import { SettingsView } from "../../src/ui/screens/Settings";
import { TogetherView } from "../../src/ui/screens/Together";

async function page() {
  setTransport(null);
  const session = await Session.open(null, { storage: new MemoryStorage(), channel: new SignalChannel(`test-${Math.random()}`), metadata: false });
  const model = new AppModel(session);
  const live = makeLive(session.channel, () => model.session.db);
  return { model, live, session };
}

afterEach(() => {
  cleanup();
  setTransport(undefined);
});

describe("social screens without a background", () => {
  it("Together says its background isn't answering", async () => {
    const { model, live } = await page();
    const view = render(
      <Page.Provider value={{ model, live }}>
        <TogetherView />
      </Page.Provider>,
    );
    expect(view.getByText("Together")).toBeTruthy();
    await waitFor(() => expect(view.getByText("Together runs in Cineon's background, which isn't answering yet.")).toBeTruthy());
  });

  it("Settings shows every section and saves a toggle", async () => {
    const { model, live, session } = await page();
    const view = render(
      <Page.Provider value={{ model, live }}>
        <SettingsView />
      </Page.Provider>,
    );
    for (const name of ["Appearance", "Ratings in the cloud", "Shields", "Watching", "Downloads and captions", "Sites", "Profiles", "Privacy and data", "Updates", "Keyboard shortcuts"]) {
      expect(view.getByText(name)).toBeTruthy();
    }
    expect(view.getByText("EasyList")).toBeTruthy();
    expect(view.getByText("Play or pause")).toBeTruthy();
    const voice = view.getByRole("switch", { name: "Voice boost" });
    expect(voice.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(voice);
    expect(session.settings.voiceBoost).toBe(true);
    await waitFor(async () => expect((await session.db.loadSettings()).voiceBoost).toBe(true));
    fireEvent.click(view.getByText("White"));
    expect(session.settings.theme).toBe("white");
  });

  it("the profile picker adds someone and switches to them", async () => {
    const { model, live, session } = await page();
    model.showProfilePicker(true);
    const view = render(
      <Page.Provider value={{ model, live }}>
        <ProfilePicker />
      </Page.Provider>,
    );
    expect(view.getByText("Who's watching?")).toBeTruthy();
    fireEvent.click(view.getByLabelText("Add a profile"));
    fireEvent.input(view.getByLabelText("Name"), { target: { value: "Sam" } });
    fireEvent.click(view.getByText("Add"));
    await waitFor(() => expect(model.session.profile.name).toBe("Sam"));
    expect(session.profiles.profiles.map((p) => p.name)).toContain("Sam");
    model.session.close();
  });

  it("asks before deleting, and Cancel says no", async () => {
    const view = render(<MenuLayer />);
    const answer = confirmDialog({ title: "Delete all saved frames?", message: "Your library stays.", confirm: "Delete frames" });
    await waitFor(() => expect(view.getByText("Delete all saved frames?")).toBeTruthy());
    fireEvent.click(view.getByText("Cancel"));
    expect(await answer).toBe(false);
    const again = confirmDialog({ title: "Clear browsing history?", confirm: "Clear history" });
    await waitFor(() => expect(view.getByText("Clear history")).toBeTruthy());
    fireEvent.click(view.getByText("Clear history"));
    expect(await again).toBe(true);
  });
});
