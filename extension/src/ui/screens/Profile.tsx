// ProfileView.swift: who you are as a watcher. Your pet, what you watch, how you watch it.

import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { DecadeCount, GenreWeight, PixelPet, ProfileStats, TopTitle } from "../../core/profile";
import { CloudStatus } from "../components/cloud";
import { Icon } from "../components/Icon";
import { OutlineButton, SilverButton } from "../components/controls";
import { PetView, PosterImage } from "../components/media";
import { grouped } from "../lib/format";
import { useLive, useModel, useSession, useTask } from "../lib/hooks";
import {
  WEEKDAYS,
  averageText,
  bingeText,
  decadeDetail,
  decadeHeight,
  favouriteDecade,
  genreBarFraction,
  genreDetail,
  genrePercent,
  heatHelp,
  heatOpacity,
  heatmapDetail,
  histogramHeight,
  hourLabel,
  petLine,
  raisedOn,
  starsDetail,
  statTiles,
  topTitleLine,
} from "../lib/profileText";
import { saveShareCard } from "../lib/shareCard";
import { addStyles } from "../lib/styles";
import css from "./profile.css";

addStyles(css);

export function ProfileView() {
  const session = useSession();
  const downloads = useLive((l) => l.downloads);
  const [adsBlocked] = useTask(() => session.db.totalStats().then((s) => s.ads).catch(() => 0), [session.version], 0);
  const downloaded = downloads.value?.items.filter((d) => d.status === "done").length ?? 0;
  const { stats, pet } = session.statsAndPet({ adsBlocked, downloads: downloaded });
  return (
    <div class="profile scroll">
      <div class="profile-column">
        <ProfileHero stats={stats} pet={pet} />
        <StatTiles stats={stats} />
        <div class="row profile-charts">
          <GenreBars genres={stats.genres} />
          <div class="col" style={{ gap: "36px", flex: "1 1 0", minWidth: 0 }}>
            <RatingHistogram counts={stats.ratingCounts} />
            <DecadeBars decades={stats.decades} />
          </div>
        </div>
        <WatchingHeatmap stats={stats} />
        {stats.topTitles.length > 0 && <TopTitles titles={stats.topTitles} />}
        <ExtrasRow stats={stats} />
      </div>
    </div>
  );
}

// MARK: Hero

/** Your pet in a spotlight, and who you are next to it. */
function ProfileHero({ stats, pet }: { stats: ProfileStats; pet: PixelPet }) {
  const model = useModel();
  const session = useSession();
  const [saving, setSaving] = useState(false);
  const raised = raisedOn(stats.genres, pet.name);
  return (
    <div class="row profile-hero">
      <div
        class="pet-stage"
        role="img"
        aria-label={`${pet.name}, your pet: a ${pet.stageLabel.toLowerCase()} ${pet.speciesLabel.toLowerCase()}, feeling ${pet.moodLabel.toLowerCase()}`}
      >
        <span class="pet-spotlight" />
        <span class="pet-floor" />
        <span class="pet-holder">
          <PetView pet={pet} size={168} />
        </span>
      </div>
      <div class="col profile-who">
        <h1 class="t-title profile-name">{session.profile.name}</h1>
        <div class="row" style={{ gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
          <span class="t-bold" style={{ fontSize: "17px", color: "var(--ink)" }}>
            {pet.name}
          </span>
          <span style={{ fontSize: "14px", color: "var(--ink2)" }}>{petLine(pet)}</span>
          <span class="mood-tag">{pet.moodLabel}</span>
        </div>
        <p class="pet-blurb">{pet.blurb}</p>
        {raised && <p class="pet-raised">{raised}</p>}
        <div class="row" style={{ gap: "10px", paddingTop: "8px" }}>
          <SilverButton
            icon="square.and.arrow.up"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              saveShareCard(stats, pet, session.profile.name)
                .catch(() => model.toast("Couldn't make the share card"))
                .finally(() => setSaving(false));
            }}
          >
            Save a share card
          </SilverButton>
          <OutlineButton icon="star.leadinghalf.filled" onClick={() => model.go("rate")}>
            Rate films
          </OutlineButton>
        </div>
      </div>
    </div>
  );
}

// MARK: Numbers

function StatTiles({ stats }: { stats: ProfileStats }) {
  const tiles = statTiles(stats);
  return (
    <div class="row stat-tiles">
      {tiles.map((tile) => (
        <Fragment key={tile.label}>
          <div class="col stat-tile">
            <span class="t-bold stat-value">{tile.value}</span>
            <span class="stat-label">{tile.label}</span>
            {tile.note && <span class="stat-note line2">{tile.note}</span>}
          </div>
          <span class="stat-divider" />
        </Fragment>
      ))}
      <div class="col stat-tile">
        <span class="row" style={{ gap: "6px", alignItems: "baseline" }}>
          <span class="gold-fill" style={{ display: "inline-flex", alignSelf: "center" }}>
            <Icon name="star.fill" size={22} />
          </span>
          <span class="t-bold stat-value">{averageText(stats.averageRating)}</span>
        </span>
        <span class="stat-note-strong">{`average of ${stats.rated} rated`}</span>
      </div>
    </div>
  );
}

// MARK: Charts

function SectionTitle({ text, detail }: { text: string; detail?: string | null }) {
  return (
    <div class="row section-title">
      <h2 class="t-title">{text}</h2>
      {detail && <span>{detail}</span>}
    </div>
  );
}

/** Share of your watching by genre. One series, so the title names it and no legend is needed. */
function GenreBars({ genres }: { genres: readonly GenreWeight[] }) {
  const top = genres.slice(0, 9);
  const most = top[0]?.weight ?? 1;
  return (
    <div class="col genre-bars">
      <SectionTitle text="Your taste" detail={genreDetail(genres)} />
      {genres.length === 0 && <span class="chart-empty">Genres appear once Cineon has found your films' details.</span>}
      <div class="col" style={{ gap: "9px" }}>
        {top.map((genre, index) => (
          <div key={genre.name} class="row genre-row" title={`${genre.name}: ${genrePercent(genre.weight)}% of your watching`}>
            <span class="genre-name line1">{genre.name}</span>
            <span class="genre-track">
              <span
                class={`genre-bar${index === 0 ? " top" : ""}`}
                style={{ width: `max(3px, ${genreBarFraction(genre.weight, most) * 100}%)` }}
              />
            </span>
            <span class="time genre-percent">{`${genrePercent(genre.weight)}%`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** How your ratings spread from 1 to 10, in gold since these are your stars. */
function RatingHistogram({ counts }: { counts: readonly number[] }) {
  const most = Math.max(1, ...counts);
  return (
    <div class="col" style={{ gap: "14px" }}>
      <SectionTitle text="Your stars" detail={starsDetail(counts)} />
      <div class="row bars" style={{ height: "110px" }}>
        {counts.map((count, index) => (
          <div key={index} class="col bar-column" title={`${count} rated ${index + 1}`}>
            <span class={`bar${count > 0 ? " gold" : " empty"}`} style={{ height: `${histogramHeight(count, most)}px` }} />
            <span class="time bar-label">{index + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecadeBars({ decades }: { decades: readonly DecadeCount[] }) {
  const favourite = favouriteDecade(decades);
  const shown = decades.slice(-9);
  const most = Math.max(1, ...shown.map((d) => d.count));
  return (
    <div class="col" style={{ gap: "14px" }}>
      <SectionTitle text="Decades" detail={decadeDetail(decades)} />
      <div class="row bars" style={{ height: "86px" }}>
        {shown.map((item) => (
          <div key={item.decade} class="col bar-column" title={`${item.count} from the ${item.decade}s`}>
            <span class={`bar${item.decade === favourite?.decade ? " silver" : " plain"}`} style={{ height: `${decadeHeight(item.count, most)}px` }} />
            <span class="time bar-label">{item.decade}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** When you watch: weekdays down, hours across, brighter for more sessions. */
function WatchingHeatmap({ stats }: { stats: ProfileStats }) {
  const most = Math.max(1, ...stats.heatmap.flat());
  return (
    <div class="col" style={{ gap: "14px" }}>
      <SectionTitle text="When you watch" detail={heatmapDetail(stats.busiestWeekday, stats.busiestHour)} />
      <div class="col heatmap">
        {stats.heatmap.map((row, day) => (
          <div key={day} class="row heat-row">
            <span class="heat-day">{WEEKDAYS[day]}</span>
            {row.map((count, hour) => (
              <span
                key={hour}
                class="heat-cell"
                title={heatHelp(day, hour, count)}
                style={count === 0 ? undefined : { background: `color-mix(in srgb, var(--ink) ${heatOpacity(count, most) * 100}%, transparent)` }}
              />
            ))}
          </div>
        ))}
        <div class="row heat-row hours">
          <span class="heat-day" />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} class="time heat-hour">
              {hour % 6 === 0 ? hourLabel(hour) : ""}
            </span>
          ))}
        </div>
      </div>
      {stats.binge && <span class="binge">{bingeText(stats.binge)}</span>}
    </div>
  );
}

function TopTitles({ titles }: { titles: readonly TopTitle[] }) {
  const model = useModel();
  const session = useSession();
  return (
    <div class="col" style={{ gap: "14px" }}>
      <SectionTitle text="Most watched" />
      <div class="row top-titles">
        {titles.map((item) => {
          const title = session.library.titles.get(item.id);
          return (
            <button key={item.id} type="button" class="col top-title" onClick={() => model.openTitle(item.id)}>
              {title && <PosterImage title={title} width={120} keepsColour />}
              <span class="line1" style={{ fontSize: "12.5px", fontWeight: 500, color: "var(--ink)" }}>
                {item.name}
              </span>
              <span style={{ fontSize: "11.5px", color: "var(--ink3)" }}>{topTitleLine(item)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExtrasRow({ stats }: { stats: ProfileStats }) {
  return (
    <div class="row extras">
      <Extra icon="camera.viewfinder" value={String(stats.moments)} label={stats.moments === 1 ? "moment saved" : "moments saved"} />
      <Extra icon="shield.lefthalf.filled" value={grouped(stats.adsBlocked)} label="ads kept off your films" />
      <Extra icon="arrow.down.circle" value={String(stats.downloads)} label="downloaded" />
      <Extra icon="square.stack" value={String(stats.backlog)} label="in your backlog" />
      <span class="spacer" />
      <CloudStatus />
    </div>
  );
}

function Extra({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <span class="row extra">
      <span style={{ color: "var(--ink3)" }}>
        <Icon name={icon} size={15} />
      </span>
      <span class="time extra-value">{value}</span>
      <span class="extra-label">{label}</span>
    </span>
  );
}

