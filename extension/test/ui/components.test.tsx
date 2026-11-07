// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/core/data";
import { setTransport } from "../../src/shared/messages";
import { StarRatingControl, halvesAt, starFill } from "../../src/ui/components/media";
import { AppModel } from "../../src/ui/lib/app";
import { Page } from "../../src/ui/lib/hooks";
import { makeLive } from "../../src/ui/lib/live";
import { Session } from "../../src/ui/lib/session";
import { LibraryView } from "../../src/ui/screens/Library";

afterEach(() => {
  cleanup();
  setTransport(undefined);
});

describe("stars", () => {
  it("fills whole and half stars", () => {
    expect([1, 2, 3, 4].map((star) => starFill(star, 5))).toEqual([1, 1, 0.5, 0]);
    expect(starFill(10, 20)).toBe(1);
  });

  it("reads half stars from the pointer: left half a half, right half the whole star", () => {
    expect(halvesAt(1, 10)).toBe(1);
    expect(halvesAt(6, 10)).toBe(2);
    expect(halvesAt(95, 10)).toBe(19);
    expect(halvesAt(500, 10)).toBe(20);
    expect(halvesAt(-4, 10)).toBe(1);
  });

  it("rates on click, clears when clicking the same rating, and moves by half a star with the arrows", () => {
    const changes: (number | null)[] = [];
    const { rerender } = render(<StarRatingControl halves={null} size={10} spacing={0} onChange={(v) => changes.push(v)} />);
    const stars = document.querySelector(".stars")!;
    // 11 pt per star: x = 60 is the right half of the sixth.
    fireEvent.click(stars, { clientX: 60 });
    expect(changes).toEqual([11]);
    rerender(<StarRatingControl halves={11} size={10} spacing={0} onChange={(v) => changes.push(v)} />);
    fireEvent.click(stars, { clientX: 60 });
    expect(changes).toEqual([11, null]);
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "Delete" });
    expect(changes).toEqual([11, null, 12, 10, null]);
    expect(slider.getAttribute("aria-valuetext")).toBe("5.5 out of 10");
  });
});

describe("Library", () => {
  it("counts each list and filters by kind and text", async () => {
    setTransport(null);
    const session = await Session.open(null, { storage: new MemoryStorage(), metadata: false });
    await session.library.addTitle("Dune", { status: "watched", kind: "film", year: 2021 });
    await session.library.addTitle("Severance", { status: "watching", kind: "series", year: 2022 });
    await session.library.addTitle("Arrival", { status: "backlog", kind: "film", year: 2016 });
    const model = new AppModel(session);
    const live = makeLive(session.channel, () => session.db);
    render(
      <Page.Provider value={{ model, live }}>
        <LibraryView />
      </Page.Provider>,
    );
    expect(screen.getByText("3 titles")).toBeTruthy();
    const everything = screen.getByRole("button", { name: /Everything/ });
    expect(everything.textContent).toContain("3");
    fireEvent.click(screen.getByRole("button", { name: "Series" }));
    expect(screen.getByText("1 title")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.input(screen.getByPlaceholderText("Find in library"), { target: { value: "arr" } });
    expect(screen.getByText("1 title")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Arrival" })).toBeTruthy();
    // Backlog switches to the checklist.
    fireEvent.input(screen.getByPlaceholderText("Find in library"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark Arrival as watched" })).toBeTruthy());
    session.close();
  });
});
