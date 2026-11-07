// PlayerControls.swift: everything you can do to what's playing, from any Cineon page. In the
// extension the player is a site's video in a tab, driven through the background.

import type { ComponentChildren } from "preact";
import { DomainName, type EpisodeRef, Timecode, VoiceBoostState } from "../../core/data";
import type { TabSnapshot } from "../../shared/messages";
import { useModel, useSession } from "../lib/hooks";
import { RefText } from "../lib/format";
import { HoverButton, IconButton, Picker, Switch } from "./controls";
import { Icon } from "./Icon";
import { MenuItem, menuButtonProps } from "./menu";
import { PosterPlaceholder, ProgressLine, RemoteImage, StarRatingControl } from "./media";

/** The name to show for a tab: its library title, what the parser found, or the page's title. */
export function tabName(tab: TabSnapshot, titleName: string | null): string {
  return titleName ?? tab.parsed?.name ?? (tab.title || (tab.host ? DomainName.registrable(tab.host) : "Now playing"));
}

/** The episode playing, if any. */
export function tabRef(tab: TabSnapshot): EpisodeRef | null {
  const ref = tab.ref ?? tab.parsed?.ref ?? null;
  return ref && (ref.season > 0 || ref.episode > 0) ? ref : null;
}

/** The header: poster, name, episode, stars, progress and the transport buttons. */
export function PlayerHeader({ tab, compact = false }: { tab: TabSnapshot; compact?: boolean }) {
  const model = useModel();
  const session = useSession();
  const title = tab.linkedTitleId != null ? session.library.titles.get(tab.linkedTitleId) ?? null : null;
  const media = tab.media;
  const ref = tabRef(tab);
  const name = tabName(tab, title?.name ?? null);
  const poster = title?.posterUrl ?? tab.parsed?.posterUrl ?? null;
  const command = (c: Parameters<typeof model.playerCommand>[1]) => void model.playerCommand(tab.tabId, c);
  return (
    <div class="col" style={{ gap: "10px" }}>
      <div class="row" style={{ gap: "11px", alignItems: "flex-start" }}>
        <RemoteImage url={poster} placeholder={<PosterPlaceholder name="" />} style={{ width: "40px", height: "60px", borderRadius: "4px", flex: "none" }} />
        <div class="col" style={{ gap: "4px", minWidth: 0 }}>
          <span class="t-title line2" style={{ fontSize: "16px", color: "var(--ink)" }}>
            {name}
          </span>
          {ref && <span style={{ fontSize: "11.5px", color: "var(--ink3)" }}>{RefText.long(ref)}</span>}
          {!ref && tab.host && compact && <span style={{ fontSize: "11.5px", color: "var(--ink3)" }}>{DomainName.registrable(tab.host)}</span>}
          {title && (
            <StarRatingControl halves={title.ratingHalves} size={11} onChange={(value) => void session.library.setRating(title.id, value)} />
          )}
        </div>
      </div>
      {media && (
        <>
          <ProgressLine fraction={media.duration > 0 ? media.position / media.duration : 0} height={2} />
          <div class="row">
            <span class="time" style={{ fontSize: "10.5px", color: "var(--ink2)" }}>
              {Timecode.string(media.position)}
            </span>
            <span class="time" style={{ fontSize: "10.5px", color: "var(--ink3)" }}>
              {"\u00a0/\u00a0" + Timecode.string(media.duration)}
            </span>
            <span class="spacer" />
            <IconButton icon="gobackward.10" label="Back 10 seconds" size={11} onClick={() => command({ kind: "skip", seconds: -10 })} />
            <IconButton
              icon={media.isPlaying ? "pause.fill" : "play.fill"}
              label={media.isPlaying ? "Pause" : "Play"}
              size={12}
              onClick={() => command({ kind: "toggle" })}
            />
            <IconButton icon="goforward.10" label="Forward 10 seconds" size={11} onClick={() => command({ kind: "skip", seconds: 10 })} />
            {ref && (
              <IconButton
                icon="forward.end.fill"
                label="Next episode"
                size={10}
                disabled={!tab.hasNextEpisode}
                onClick={() => command({ kind: "nextEpisode" })}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A row with a name on the left and its control on the right (ControlRow). */
export function ControlRow({ icon, label, note, children }: { icon: string; label: string; note?: string | null; children: ComponentChildren }) {
  return (
    <div class="row" style={{ gap: "10px", alignItems: "flex-start" }}>
      <span style={{ width: "16px", color: "var(--ink3)", paddingTop: "1px" }}>
        <Icon name={icon} size={14} />
      </span>
      <span class="col" style={{ gap: "2px", flex: "1 1 auto", minWidth: 0 }}>
        <span style={{ fontSize: "12.5px", fontWeight: 500, color: "var(--ink)" }}>{label}</span>
        {note && <span style={{ fontSize: "11px", color: "var(--ink3)" }}>{note}</span>}
      </span>
      {children}
    </div>
  );
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

/** PlayerControlsPanel: the popover under the now-playing pill. */
export function PlayerControlsPanel({ tab, close }: { tab: TabSnapshot | null; close: () => void }) {
  const model = useModel();
  const session = useSession();
  if (!tab) {
    return (
      <div style={{ padding: "16px", width: "320px", fontSize: "12.5px", color: "var(--ink3)" }}>Nothing is playing</div>
    );
  }
  const voiceBoost = session.settings.voiceBoost;
  const rate = tab.media?.rate ?? 1;
  const act = (command: Parameters<typeof model.playerCommand>[1]) => {
    close();
    void model.playerCommand(tab.tabId, command);
  };
  return (
    <div class="col" style={{ gap: "14px", padding: "16px", width: "320px" }}>
      <PlayerHeader tab={tab} />
      <div class="menu-divider" style={{ margin: 0 }} />
      <ControlRow
        icon="waveform.and.person.filled"
        label="Voice boost"
        note={voiceBoost ? VoiceBoostState.note(tab.voiceBoost) ?? "Dialogue up, explosions down" : "Clearer dialogue at night"}
      >
        <Switch mini on={voiceBoost} label="Voice boost" onChange={(value) => void session.updateSettings({ voiceBoost: value })} />
      </ControlRow>
      <ControlRow icon="gauge.with.dots.needle.50percent" label="Speed">
        <Picker
          label="Speed"
          value={SPEEDS.includes(rate as (typeof SPEEDS)[number]) ? rate : 1}
          options={SPEEDS.map((value) => ({ value, label: value === 1 ? "1×" : `${value}×` }))}
          onChange={(value) => void model.playerCommand(tab.tabId, { kind: "rate", rate: value })}
        />
      </ControlRow>
      <div class="menu-divider" style={{ margin: 0 }} />
      <div class="col" style={{ gap: "2px" }}>
        <ActionRow icon="pip.enter" label="Picture in Picture" onClick={() => act({ kind: "pictureInPicture" })} />
        <ActionRow icon="camera.viewfinder" label="Save this moment" onClick={() => act({ kind: "saveMoment" })} />
        <ActionRow icon="arrow.triangle.branch" label="Find on another site" onClick={() => act({ kind: "findElsewhere" })} />
        <ActionRow
          icon="arrow.up.forward"
          label="Go to the tab"
          onClick={() => {
            close();
            void model.focusTab(tab.tabId);
          }}
        />
        <HoverButton
          {...menuButtonProps(() => (
            <>
              <MenuItem onSelect={() => model.openSheet({ kind: "relink", tabId: tab.tabId })}>Fix title…</MenuItem>
              <MenuItem onSelect={() => void model.trackerCommand("tracker.ignore", tab.tabId)}>This isn't a film</MenuItem>
              <MenuItem
                onSelect={() => {
                  void model.trackerCommand("tracker.stopSite", tab.tabId);
                  model.toast(`${DomainName.registrable(tab.host ?? "This site")} won't appear on your timeline`);
                }}
              >
                Don't track this site
              </MenuItem>
            </>
          ))}
        >
          <Icon name="ellipsis.circle" size={15} />
          <span style={{ fontSize: "12.5px", color: "var(--ink2)" }}>Tracking</span>
        </HoverButton>
      </div>
    </div>
  );
}

export function ActionRow({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <HoverButton onClick={onClick} style={{ width: "100%", color: "var(--ink2)", fontSize: "12.5px" }}>
      <Icon name={icon} size={15} />
      <span>{label}</span>
    </HoverButton>
  );
}
