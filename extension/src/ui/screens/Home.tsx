// HomeView.swift: the film you were in the middle of, set like an opening title, then shelves.
// With nothing in progress, the welcome hero: search, your sites, import.

import { type Site, type Title, type WatchProgress } from "../../core/data";
import { Icon } from "../components/Icon";
import { HoverButton, OutlineButton, SilverButton } from "../components/controls";
import { contextMenuProps, MenuDivider, MenuItem } from "../components/menu";
import { LogoMark, ProgressLine, RemoteImage, SiteIcon, useFrameUrl } from "../components/media";
import { PosterShelf } from "../components/titles";
import { isVisitOnly } from "../lib/format";
import { useModel, useSession, useTask } from "../lib/hooks";
import { alertBadge, freshAlerts, heroDetailLine, resumeLabel } from "../lib/library";
import { addStyles } from "../lib/styles";
import { shortcut } from "../lib/platform";
import css from "./home.css";

addStyles(css);

export function HomeView() {
  const session = useSession();
  const library = session.library;
  const resuming = library.continueWatching;
  const [alerts] = useTask(() => session.db.episodeAlerts().catch(() => []), [session.version], []);
  const fresh = freshAlerts(alerts, library.titles);
  const first = resuming[0];
  return (
    <div class="home scroll">
      {first ? <HomeHero title={first.title} progress={first.progress} /> : <WelcomeHero />}
      <div class="home-shelves">
        {fresh.length > 0 && (
          <PosterShelf
            name="New episodes"
            titles={fresh.map((f) => f.title)}
            badges={new Map(fresh.map((f) => [f.title.id, alertBadge(f.alert)]))}
          />
        )}
        {resuming.length > 1 && <PosterShelf name="Continue watching" titles={resuming.slice(1).map((r) => r.title)} showProgress />}
        {library.backlog.length > 0 && <PosterShelf name="Backlog" titles={library.backlog.slice(0, 14)} destination="library" />}
        {library.watched.length > 0 && <PosterShelf name="Watched" titles={library.watched.slice(0, 14)} destination="library" />}
      </div>
    </div>
  );
}

/** The film you were in the middle of. */
function HomeHero({ title, progress }: { title: Title; progress: WatchProgress }) {
  const model = useModel();
  const frame = title.backdropUrl ? null : model.library.bestFrame(title.id);
  const frameUrl = useFrameUrl(frame);
  const image = title.backdropUrl ?? frameUrl ?? title.posterUrl;
  const visitOnly = isVisitOnly(progress);
  return (
    <section class="home-hero">
      <RemoteImage url={image} class="hero-image" placeholder={<div class="hero-blank" />} />
      <div class="hero-shade" />
      <div class="hero-text">
        <h1 class="t-title hero-name">{title.name}</h1>
        <p class="hero-detail">{heroDetailLine(progress)}</p>
        {!visitOnly && <ProgressLine fraction={progress.duration > 0 ? progress.position / progress.duration : 0} height={3} width={280} style={{ margin: "4px 0" }} />}
        <div class="row" style={{ gap: "10px", marginTop: "4px" }}>
          <SilverButton large icon="play.fill" onClick={() => model.resume(title)}>
            {resumeLabel(progress)}
          </SilverButton>
          <OutlineButton large onClick={() => model.openTitle(title.id)}>
            Details
          </OutlineButton>
        </div>
      </div>
    </section>
  );
}

/** First run, or nothing in progress: go straight to choosing something. */
function WelcomeHero() {
  const model = useModel();
  const session = useSession();
  return (
    <section class="welcome">
      <LogoMark size={96} />
      <h1 class="t-title welcome-title">What are we watching?</h1>
      <button type="button" class="welcome-search" onClick={() => model.openCommandBar()}>
        <Icon name="magnifyingglass" size={16} />
        <span>Search your sites, or add a film to the backlog</span>
        <span class="spacer" />
        <span class="welcome-key">{shortcut("K")}</span>
      </button>
      <SitesRow />
      {session.library.titles.size === 0 && (
        <OutlineButton style={{ marginTop: "6px" }} onClick={() => model.openSheet({ kind: "import" })}>
          Import from this browser's history
        </OutlineButton>
      )}
    </section>
  );
}

export function SitesRow() {
  const model = useModel();
  const session = useSession();
  return (
    <div class="sites-row">
      {session.library.sites.slice(0, 6).map((site) => (
        <HoverButton key={site.id} class="site-tile-big" onClick={() => void model.openSite(site)} {...siteMenu(site)}>
          <span class="site-box">
            <SiteIcon name={site.name} url={site.iconUrl} size={28} />
          </span>
          <span class="site-name line1">{site.name}</span>
        </HoverButton>
      ))}
      <HoverButton class="site-tile-big" onClick={() => model.openSheet({ kind: "addSite", prefill: null })}>
        <span class="site-box add">
          <Icon name="plus" size={19} />
        </span>
        <span class="site-name">Add site</span>
      </HoverButton>
    </div>
  );
}

/** A site's right-click menu (SiteTile's context menu). */
export function siteMenu(site: Site) {
  // Imported lazily by the screens that need it; the model is read when the menu opens.
  return contextMenuProps(() => <SiteMenuItems site={site} />);
}

function SiteMenuItems({ site }: { site: Site }) {
  const model = useModel();
  return (
    <>
      <MenuItem onSelect={() => void model.openUrl(site.homeUrl)}>Open in new tab</MenuItem>
      <MenuItem onSelect={() => model.openSheet({ kind: "editSite", siteId: site.id })}>Edit…</MenuItem>
      <MenuDivider />
      <MenuItem onSelect={() => void model.library.removeSite(site.id)}>Remove</MenuItem>
    </>
  );
}
