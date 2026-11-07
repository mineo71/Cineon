// The side panel (Chrome) / sidebar (Firefox): app.html#panel. A compact Cineon beside the site
// you're watching: what's playing with its controls (PlayerControls.swift's header and actions),
// where you stopped (HomeView's Continue watching), and rate mode one poster at a time
// (RateModeView.swift's keys). Everything else opens the full Cineon page.

import { send, type TabSnapshot } from "../../shared/messages";
import { Icon } from "../components/Icon";
import { HoverButton, IconButton } from "../components/controls";
import { LogoMark, PetView, PosterImage, ProgressLine } from "../components/media";
import { PlayerHeader } from "../components/player";
import { NO_BACKGROUND } from "../lib/app";
import { isVisitOnly } from "../lib/format";
import { useLive, useModel, useSession } from "../lib/hooks";
import { continueDetail, titleHash } from "../lib/popup";
import { addStyles } from "../lib/styles";
import { ToastHost } from "../components/overlay";
import { QuickRating, SectionHead, appUrl } from "./PanelRating";
import css from "./panel.css";

addStyles(css);

export { QuickRating, appUrl };

export function SidePanel() {
  return (
    <div class="side-panel">
      <PanelHeader />
      <div class="panel-body scroll">
        <NowPlaying />
        <ContinueWatching />
        <QuickRating />
      </div>
      <ToastHost />
    </div>
  );
}

function PanelHeader() {
  const model = useModel();
  const session = useSession();
  const { pet } = session.statsAndPet();
  return (
    <header class="panel-header">
      <LogoMark size={20} />
      <span class="t-bold panel-brand">Cineon</span>
      <span class="spacer" />
      <IconButton icon="arrow.up.right.square" label="Open Cineon" size={13} onClick={() => void model.openUrl(appUrl())} />
      <button
        type="button"
        class="panel-avatar"
        title={`${session.profile.name}: profile`}
        aria-label={`${session.profile.name}: profile`}
        onClick={() => void model.openUrl(appUrl("#profile"))}
      >
        <PetView pet={pet} size={24} animated={false} />
      </button>
    </header>
  );
}

/** What's playing in any tab, with its controls. */
function NowPlaying() {
  const player = useLive((l) => l.player);
  const tab = player.value?.tab ?? null;
  return (
    <section class="panel-section">
      <SectionHead name="Now playing" />
      {tab ? (
        <NowPlayingCard tab={tab} />
      ) : (
        <p class="panel-quiet">
          Play something on a site and it shows here.
          {player.settled && !player.answered && <span class="panel-note">{NO_BACKGROUND}</span>}
        </p>
      )}
    </section>
  );
}

function NowPlayingCard({ tab }: { tab: TabSnapshot }) {
  const model = useModel();
  const command = (kind: "saveMoment" | "findElsewhere") => void model.playerCommand(tab.tabId, { kind });
  const download = async () => {
    const answer = await send("downloads.start", { tabId: tab.tabId });
    if (!answer) model.toast(NO_BACKGROUND);
    else if (answer.message) model.toast(answer.message);
  };
  return (
    <div class="panel-card">
      <PlayerHeader tab={tab} compact />
      <div class="panel-actions">
        <PanelAction icon="camera.viewfinder" label="Save this moment" onClick={() => command("saveMoment")} />
        <PanelAction icon="arrow.triangle.branch" label="Find on another site" onClick={() => command("findElsewhere")} />
        <PanelAction
          icon="arrow.down.circle"
          label="Download this video"
          disabled={!tab.canDownload}
          note={tab.canDownload ? null : "Start the video first"}
          onClick={() => void download()}
        />
        <PanelAction icon="arrow.up.forward" label="Go to the tab" onClick={() => void model.focusTab(tab.tabId)} />
      </div>
    </div>
  );
}

function PanelAction({
  icon,
  label,
  onClick,
  disabled,
  note,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  note?: string | null;
}) {
  return (
    <HoverButton class="panel-action" disabled={disabled} title={note ?? undefined} onClick={onClick}>
      <Icon name={icon} size={15} />
      <span>{label}</span>
    </HoverButton>
  );
}

/** Where you stopped, latest first; a row carries on, its poster opens the title in Cineon. */
function ContinueWatching() {
  const model = useModel();
  const session = useSession();
  const entries = session.library.continueWatching.slice(0, 8);
  if (entries.length === 0) return null;
  return (
    <section class="panel-section">
      <SectionHead name="Continue watching" />
      <div class="col" style={{ gap: "2px" }}>
        {entries.map(({ title, progress }) => (
          <div key={title.id} class="panel-continue" role="button" tabIndex={0} onClick={() => model.resume(title)} onKeyDown={(event) => {
            if (event.key === "Enter") model.resume(title);
          }}>
            <button
              type="button"
              class="panel-continue-poster"
              title={`${title.name}: details`}
              aria-label={`${title.name}: details`}
              onClick={(event) => {
                event.stopPropagation();
                void model.openUrl(appUrl(titleHash(title.id)));
              }}
            >
              <PosterImage title={title} width={34} radius={3} keepsColour />
            </button>
            <span class="col panel-continue-text">
              <span class="line1 panel-continue-name">{title.name}</span>
              <span class="line1 panel-continue-detail">{continueDetail(progress)}</span>
              {!isVisitOnly(progress) && (
                <ProgressLine fraction={progress.duration > 0 ? progress.position / progress.duration : 0} height={2} style={{ marginTop: "4px" }} />
              )}
            </span>
            <Icon name="play.fill" size={11} class="panel-continue-play" />
          </div>
        ))}
      </div>
    </section>
  );
}
