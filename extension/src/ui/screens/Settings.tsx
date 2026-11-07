// SettingsView.swift: every section that applies to an extension, with the Mac's wording where
// the browser doesn't change it. Settings are per profile (IndexedDB), saved as they change and
// announced to the background with a `settings` signal (Session.updateSettings).

import { type ComponentChildren, Fragment } from "preact";
import { useRef, useState } from "preact/hooks";
import {
  type AppSettings,
  AppTheme,
  CaptionStyle,
  LibraryExport,
  SearchEngine,
  ShieldStats,
} from "../../core/data";
import { send } from "../../shared/messages";
import { CloudStatus } from "../components/cloud";
import { confirmDialog } from "../components/confirm";
import { Icon } from "../components/Icon";
import { OutlineButton, Picker, SettingSlider, SettingToggle, SilverButton } from "../components/controls";
import { LogoMark, SiteIcon } from "../components/media";
import { NO_BACKGROUND } from "../lib/app";
import { useLive, useModel, useSession, useTask } from "../lib/hooks";
import { FILTER_CATALOG } from "../lib/live";
import { isMac, shortcut } from "../lib/platform";
import {
  blockedSummary,
  canRestore,
  commandRows,
  framesButtonLabel,
  idleTabsText,
  importResultText,
  listDetail,
  pageShortcutRows,
  percentText,
} from "../lib/settings";
import { addStyles } from "../lib/styles";
import css from "./settings.css";

addStyles(css);

/** The settings, and a setter that saves one key and tells everyone else. */
function useSettings(): [AppSettings, <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void] {
  const session = useSession();
  return [session.settings, (key, value) => void session.updateSettings({ [key]: value } as Partial<AppSettings>)];
}

export function SettingsView() {
  return (
    <div class="settings scroll">
      <div class="settings-column">
        <h1 class="t-title settings-title">Settings</h1>
        <AppearanceSection />
        <CloudSection />
        <ShieldsSection />
        <WatchingSection />
        <DownloadsSection />
        <SitesSection />
        <ProfilesSection />
        <PrivacySection />
        <UpdatesSection />
        <ShortcutsSection />
      </div>
    </div>
  );
}

function Section({ name, children }: { name: string; children: ComponentChildren }) {
  return (
    <section class="settings-section">
      <h2 class="t-title">{name}</h2>
      <div class="settings-rows">{children}</div>
    </section>
  );
}

function Note({ children }: { children: ComponentChildren }) {
  return <p class="settings-note">{children}</p>;
}

// MARK: Appearance

function AppearanceSection() {
  const [settings, set] = useSettings();
  return (
    <Section name="Appearance">
      <div class="row" style={{ gap: "14px" }}>
        {AppTheme.allCases.map((theme) => (
          <ThemeCard key={theme} theme={theme} selected={settings.theme === theme} onPick={() => set("theme", theme)} />
        ))}
      </div>
      <SettingToggle
        label="Ambient light"
        detail="The film's colours spill onto the page around the player while it plays."
        on={settings.ambientLight}
        onChange={(value) => set("ambientLight", value)}
      />
      {settings.ambientLight && (
        <SettingSlider
          label="Strength"
          valueText={percentText(settings.ambientStrength)}
          value={settings.ambientStrength}
          min={0.15}
          max={1}
          onChange={(value) => set("ambientStrength", value)}
        />
      )}
      <SettingToggle label="Logo animation on launch" on={settings.launchAnimation} onChange={(value) => set("launchAnimation", value)} />
    </Section>
  );
}

function ThemeCard({ theme, selected, onPick }: { theme: AppTheme; selected: boolean; onPick: () => void }) {
  const sample = theme === "dark" ? { canvas: "#000", ink: "#fff" } : { canvas: "#fff", ink: "#000" };
  return (
    <button type="button" class={`theme-card${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onPick}>
      <span class="theme-sample" style={{ background: sample.canvas }}>
        <LogoMark size={52} color={sample.ink} />
      </span>
      <span class="theme-name">{AppTheme.label(theme)}</span>
    </button>
  );
}

// MARK: Cloud


function CloudSection() {
  const model = useModel();
  const [settings, set] = useSettings();
  const together = useLive((l) => l.together);
  const [showsCode, setShowsCode] = useState(false);
  const [entered, setEntered] = useState("");
  const [restoring, setRestoring] = useState(false);
  const code = together.value?.recoveryCode ?? null;
  const restore = async () => {
    setRestoring(true);
    const answer = await send("together.adopt", { recoveryCode: entered.trim() }, { timeoutMs: 30_000 });
    setRestoring(false);
    setEntered("");
    if (!answer) model.toast(NO_BACKGROUND);
    else model.toast(answer.ok ? "Restored. Ratings and lists from that code are back" : "That code didn't work");
    void together.live.refresh();
  };
  return (
    <Section name="Ratings in the cloud">
      <SettingToggle
        label="Back up ratings and lists"
        detail="Your stars and which list each film is in are kept on Cineon's server, so they come back after you clear the library, import again or use another computer. Watch history stays here."
        on={settings.cloudBackup}
        onChange={(value) => set("cloudBackup", value)}
      />
      <SettingToggle
        label="Show my pet to friends"
        detail="Your pixel pet is your picture in parties and challenges."
        on={settings.sharePet}
        onChange={(value) => set("sharePet", value)}
      />
      <CloudStatus />
      <div class="col" style={{ gap: "8px" }}>
        <span class="settings-label">Recovery code</span>
        <Note>
          Enter it on another computer or a new profile to bring back your ratings, lists and challenges. Keep it to yourself: anyone with it
          can change them.
        </Note>
        <div class="row" style={{ gap: "8px" }}>
          <span class="time recovery-code">{code == null ? "Not available until Cineon's background answers" : showsCode ? code : "•".repeat(24)}</span>
          <span class="spacer" />
          <OutlineButton disabled={code == null} onClick={() => setShowsCode(!showsCode)}>
            {showsCode ? "Hide" : "Show"}
          </OutlineButton>
          <OutlineButton disabled={code == null} onClick={() => code && void model.copy(code, "Recovery code copied")}>
            Copy
          </OutlineButton>
        </div>
        <div class="row" style={{ gap: "8px" }}>
          <input
            class="field small time recovery-field"
            value={entered}
            placeholder="Paste a recovery code"
            aria-label="Paste a recovery code"
            spellcheck={false}
            autoComplete="off"
            onInput={(event) => setEntered((event.currentTarget as HTMLInputElement).value)}
          />
          <SilverButton disabled={!canRestore(entered) || restoring} onClick={() => void restore()}>
            {restoring ? "Restoring…" : "Restore"}
          </SilverButton>
        </div>
      </div>
    </Section>
  );
}

// MARK: Shields

function ShieldsSection() {
  const session = useSession();
  const [settings, set] = useSettings();
  const shields = useLive((l) => l.shields);
  const [total] = useTask(() => session.db.totalStats().catch(() => ShieldStats.make()), [session.version], ShieldStats.make());
  const catalog = shields.value?.catalog ?? FILTER_CATALOG;
  const counts = shields.value?.ruleCounts ?? {};
  const toggleList = (id: string, on: boolean) => {
    const lists = new Set(settings.enabledLists);
    if (on) lists.add(id);
    else lists.delete(id);
    set("enabledLists", [...lists]);
  };
  return (
    <Section name="Shields">
      <p class="settings-text">{blockedSummary(total)}</p>
      <SettingToggle
        label="Block ads and trackers"
        detail="Built into the browser's own request blocking, so it adds almost nothing to load time."
        on={settings.networkBlocking}
        onChange={(value) => set("networkBlocking", value)}
      />
      <SettingToggle label="Block pop-ups" detail="Stops windows that open to other sites when you click." on={settings.popupShield} onChange={(value) => set("popupShield", value)} />
      <SettingToggle
        label="Block redirects"
        detail="Stops scripts sending the whole page to another site."
        on={settings.redirectShield}
        onChange={(value) => set("redirectShield", value)}
      />
      <SettingToggle
        label="Remove click traps"
        detail="Clears invisible layers placed over the player to steal your first click."
        on={settings.overlaySweeper}
        onChange={(value) => set("overlaySweeper", value)}
      />
      <SettingToggle
        label="Block downloads"
        detail="Stops the fake player and codec downloads streaming sites push."
        on={settings.downloadShield}
        onChange={(value) => set("downloadShield", value)}
      />
      {settings.networkBlocking && (
        <>
          <div class="hairline" />
          {catalog.map((info) => (
            <SettingToggle
              key={info.id}
              label={info.name}
              detail={listDetail(info.summary, counts[info.id])}
              on={settings.enabledLists.includes(info.id)}
              onChange={(value) => toggleList(info.id, value)}
            />
          ))}
          <Note>{shields.value?.status ?? "The lists are built into the extension and update with it."}</Note>
        </>
      )}
    </Section>
  );
}

// MARK: Watching

function WatchingSection() {
  const [settings, set] = useSettings();
  return (
    <Section name="Watching">
      <SettingToggle
        label="Resume where I stopped"
        detail="Jumps to your place as soon as the video loads, with a way to start over."
        on={settings.autoResume}
        onChange={(value) => set("autoResume", value)}
      />
      <SettingToggle
        label="Only one film at a time"
        detail="Starting a video pauses any other tab that's playing."
        on={settings.pauseOtherTabs}
        onChange={(value) => set("pauseOtherTabs", value)}
      />
      <SettingToggle
        label="Rescue films from dead sites"
        detail="When a site or video stops working, looks at the site's other addresses and then your other sites, and carries on from the same second."
        on={settings.autoRescue}
        onChange={(value) => set("autoRescue", value)}
      />
      <SettingToggle
        label="Learn what I skip"
        detail="Skip an intro once, and Cineon offers to skip it in every episode of that series. Each skip can be undone."
        on={settings.learnSkips}
        onChange={(value) => set("learnSkips", value)}
      />
      <SettingToggle
        label="Play the next episode"
        detail="Offers it when the credits start, and plays it when the episode ends."
        on={settings.autoNextEpisode}
        onChange={(value) => set("autoNextEpisode", value)}
      />
      <SettingToggle
        label="Keep frames from what I watch"
        detail="Saves a few small images from each session for your timeline. They stay in this browser."
        on={settings.keepFrames}
        onChange={(value) => set("keepFrames", value)}
      />
      <SettingToggle
        label="Voice boost"
        detail="Dialogue louder, rumble and explosions softer. Works in players that let Cineon change their sound; others are left as they are."
        on={settings.voiceBoost}
        onChange={(value) => set("voiceBoost", value)}
      />
      <SettingToggle
        label="Tell me about new episodes"
        detail="Checks the series you're watching every few hours and sends a notification when a new episode is out."
        on={settings.newEpisodeAlerts}
        onChange={(value) => set("newEpisodeAlerts", value)}
      />
      <SettingSlider
        label="Count as finished at"
        valueText={percentText(settings.finishThreshold)}
        value={settings.finishThreshold}
        min={0.7}
        max={1}
        step={0.01}
        onChange={(value) => set("finishThreshold", value)}
      />
      <SettingSlider
        label="Start tracking after"
        valueText={`${Math.trunc(settings.minimumSecondsToTrack)} s`}
        value={settings.minimumSecondsToTrack}
        min={5}
        max={120}
        step={5}
        onChange={(value) => set("minimumSecondsToTrack", value)}
      />
      <SettingSlider
        label="Let the browser free idle tabs after"
        valueText={idleTabsText(settings.hibernateMinutes)}
        value={settings.hibernateMinutes}
        min={0}
        max={120}
        step={5}
        onChange={(value) => set("hibernateMinutes", value)}
      />
    </Section>
  );
}

// MARK: Downloads and captions

function DownloadsSection() {
  const [settings, set] = useSettings();
  const [commands] = useTask(() => readCommands(), [], null as chrome.commands.Command[] | null);
  const downloadKeys = commandRows(commands, isMac()).find((row) => row.label === "Download this video")?.keys ?? "Alt+Shift+S";
  return (
    <Section name="Downloads and captions">
      <SettingToggle
        label="Show a download button on players"
        detail={`Appears in the player's corner when you move the mouse. ${downloadKeys} works either way.`}
        on={settings.showDownloadButton}
        onChange={(value) => set("showDownloadButton", value)}
      />
      <SettingToggle
        label="Play the next downloaded episode"
        detail="When a downloaded episode ends in Cineon's player, the next one starts after a short countdown."
        on={settings.playNextDownload}
        onChange={(value) => set("playNextDownload", value)}
      />
      <SettingToggle
        label="Remove episodes once watched"
        detail="A downloaded episode you watched to the end is deleted when you move on, to save space."
        on={settings.binWatchedDownloads}
        onChange={(value) => set("binWatchedDownloads", value)}
      />
      <div class="col" style={{ gap: "1px" }}>
        <span class="settings-label">Save downloads to</span>
        <span style={{ fontSize: "11.5px", color: "var(--ink3)" }}>
          Your browser's downloads folder. Where that is, and whether to ask each time, is set in the browser's own settings.
        </span>
      </div>
      <div class="row" style={{ gap: "10px" }}>
        <span class="settings-label">Captions</span>
        <Picker
          label="Captions"
          value={settings.captionStyle}
          options={CaptionStyle.allCases.map((style) => ({ value: style, label: CaptionStyle.label(style) }))}
          onChange={(value) => set("captionStyle", value)}
        />
      </div>
      <Note>Larger captions apply to players that use the browser's own subtitles.</Note>
    </Section>
  );
}

// MARK: Sites

function SitesSection() {
  const model = useModel();
  const session = useSession();
  return (
    <Section name="Sites">
      {session.library.sites.map((site) => (
        <div key={site.id} class="row" style={{ gap: "10px" }}>
          <SiteIcon name={site.name} url={site.iconUrl} size={20} />
          <span class="col" style={{ gap: "1px", minWidth: 0 }}>
            <span style={{ fontSize: "13px", color: "var(--ink)" }}>{site.name}</span>
            <span class="line1" style={{ fontSize: "12px", color: "var(--ink3)" }}>
              {site.searchTemplate == null ? `${site.host}. Search not learned yet.` : site.host}
            </span>
          </span>
          <span class="spacer" />
          <OutlineButton onClick={() => model.openSheet({ kind: "editSite", siteId: site.id })}>Edit</OutlineButton>
        </div>
      ))}
      <div class="row" style={{ gap: "10px", flexWrap: "wrap" }}>
        <OutlineButton onClick={() => model.openSheet({ kind: "addSite", prefill: null })}>Add a site</OutlineButton>
        <OutlineButton onClick={() => model.openSheet({ kind: "import" })}>Import from this browser's history</OutlineButton>
      </div>
    </Section>
  );
}

// MARK: Profiles

function ProfilesSection() {
  const model = useModel();
  const session = useSession();
  const [name, setName] = useState(session.profile.name);
  const rename = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    await session.profiles.rename(session.profile.id, trimmed);
    session.notifyProfiles();
    model.toast(`Renamed to ${trimmed}`);
  };
  return (
    <Section name="Profiles">
      <p class="settings-text" style={{ fontSize: "12.5px" }}>
        Each profile has its own library, timeline and settings. Site logins belong to the browser's own profile.
      </p>
      <div class="row" style={{ gap: "10px", flexWrap: "wrap" }}>
        <input
          class="field small"
          style={{ width: "180px" }}
          value={name}
          placeholder="Name"
          aria-label="Name"
          onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void rename();
          }}
        />
        <OutlineButton onClick={() => void rename()}>Rename</OutlineButton>
        <OutlineButton onClick={() => model.showProfilePicker(true)}>Who's watching…</OutlineButton>
      </div>
      <SettingToggle
        label="Ask who's watching when Cineon opens"
        on={session.profiles.askOnLaunch}
        onChange={(value) => {
          void session.profiles.setAskOnLaunch(value).then(() => session.notifyProfiles());
        }}
      />
    </Section>
  );
}

// MARK: Privacy and data

function PrivacySection() {
  const model = useModel();
  const session = useSession();
  const [settings, set] = useSettings();
  const [framesSize, setFramesSize] = useState<number | null>(null);
  const [measured] = useTask(() => session.library.framesSize().catch(() => 0), [session.version], 0);
  const size = framesSize ?? measured;
  const file = useRef<HTMLInputElement>(null);

  const exportLibrary = () => {
    try {
      const text = LibraryExport.make(session.library);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "Cineon library.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      model.toast("Library exported");
    } catch (error) {
      model.toast(`Couldn't export: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const importFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    try {
      const result = await LibraryExport.importText(session.library, await chosen.text());
      if (result) {
        session.noteCloudChanges(result.titles.map((t) => t.id));
        for (const title of result.titles) if (!title.metadataChecked) session.metadata.enrich(title.id, null, true);
      }
      model.toast(importResultText(result));
    } catch (error) {
      model.toast(`Couldn't import: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const deleteFrames = async () => {
    const ok = await confirmDialog({
      title: "Delete all saved frames?",
      message: "This includes moments you saved. Your library and timeline stay.",
      confirm: "Delete frames and moments",
    });
    if (!ok) return;
    await session.library.deleteAllFrames();
    setFramesSize(0);
    model.toast("Frames deleted");
  };

  const clearHistory = async () => {
    const ok = await confirmDialog({ title: "Clear browsing history?", message: "Your library and film timeline stay.", confirm: "Clear history" });
    if (!ok) return;
    await session.db.clearHistory().catch(() => undefined);
    model.toast("Browsing history cleared");
  };

  return (
    <Section name="Privacy and data">
      <SettingToggle
        label="Fetch posters and details"
        detail="Sends film names to IMDb and Cinemeta. Without it, Cineon uses each page's own image and title."
        on={settings.fetchMetadata}
        onChange={(value) => set("fetchMetadata", value)}
      />
      <SettingToggle
        label="Save browsing history"
        detail="Pages for the command bar. Your film timeline is saved either way."
        on={settings.saveBrowsingHistory}
        onChange={(value) => set("saveBrowsingHistory", value)}
      />
      <div class="row" style={{ gap: "10px" }}>
        <span class="settings-label">Web search</span>
        <Picker
          label="Web search"
          value={settings.searchEngine}
          options={SearchEngine.allCases.map((engine) => ({ value: engine, label: SearchEngine.label(engine) }))}
          onChange={(value) => set("searchEngine", value)}
        />
      </div>
      <div class="row" style={{ gap: "10px", flexWrap: "wrap" }}>
        <OutlineButton onClick={exportLibrary}>Export library</OutlineButton>
        <OutlineButton onClick={() => file.current?.click()}>Import a library file</OutlineButton>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            void importFile(input.files?.[0]);
            input.value = "";
          }}
        />
        <OutlineButton onClick={() => void deleteFrames()}>{framesButtonLabel(size)}</OutlineButton>
        <OutlineButton onClick={() => void clearHistory()}>Clear browsing history</OutlineButton>
      </div>
      <Note>Cookies and site logins belong to the browser. Clear them from its own privacy settings.</Note>
    </Section>
  );
}

// MARK: Updates

function UpdatesSection() {
  const version = typeof __VERSION__ === "string" ? __VERSION__ : "in development";
  return (
    <Section name="Updates">
      <div class="col" style={{ gap: "1px" }}>
        <span style={{ fontSize: "13px", color: "var(--ink)" }}>{`Cineon ${version}`}</span>
        <span style={{ fontSize: "12px", color: "var(--ink3)" }}>
          Your browser keeps Cineon up to date. Copies installed from GitHub get new versions from Cineon's releases page.
        </span>
      </div>
    </Section>
  );
}

// MARK: Shortcuts

async function readCommands(): Promise<chrome.commands.Command[] | null> {
  const commands = (globalThis as { chrome?: typeof chrome }).chrome?.commands;
  if (!commands?.getAll) return null;
  try {
    return await commands.getAll();
  } catch {
    return null;
  }
}

function browserKind(): "firefox" | "edge" | "chrome" {
  if (typeof __TARGET__ === "string" && __TARGET__ === "firefox") return "firefox";
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Firefox\//.test(agent)) return "firefox";
  return /Edg\//.test(agent) ? "edge" : "chrome";
}

function ShortcutsSection() {
  const model = useModel();
  const [commands] = useTask(() => readCommands(), [], null as chrome.commands.Command[] | null);
  const rows = [...commandRows(commands, isMac()), ...pageShortcutRows(shortcut("K"))];
  const kind = browserKind();
  return (
    <Section name="Keyboard shortcuts">
      <div class="shortcut-grid">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <span style={{ color: "var(--ink2)" }}>{row.label}</span>
            <span style={{ color: "var(--ink)" }}>{row.keys}</span>
          </Fragment>
        ))}
      </div>
      {kind === "firefox" ? (
        <Note>Change the first four in Firefox's Add-ons Manager: the gear menu, then Manage Extension Shortcuts.</Note>
      ) : (
        <div>
          <OutlineButton onClick={() => void model.openUrl(kind === "edge" ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts")}>
            Change shortcuts
          </OutlineButton>
        </div>
      )}
    </Section>
  );
}
