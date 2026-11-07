// TogetherView.swift: watching with friends — parties, challenges and lists shared by code. The
// TogetherModel lives in the background (a party has to outlive this page), so this page shows
// its snapshots and sends it what you do.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Timecode } from "../../core/data";
import {
  type ChallengeMember,
  type ChallengeState,
  type ChallengeSummary,
  type PartyMessage,
  PartyMessage as PartyMessages,
  type PartyState,
  type ShareInfo,
  ShareCode,
  type TitleCard,
} from "../../core/together";
import { type TogetherSnapshot, type UiPayload, type UiRequestType, type UiResult, send } from "../../shared/messages";
import { Icon } from "../components/Icon";
import { HoverButton, OutlineButton, SilverButton, Spinner } from "../components/controls";
import { MenuItem, menuButtonProps } from "../components/menu";
import { CardPoster, PersonAvatar, PosterImage, PosterPlaceholder, ProgressLine, RemoteImage, StarRow } from "../components/media";
import { NO_BACKGROUND } from "../lib/app";
import { DateText } from "../lib/format";
import { useHover, useLive, useModel, useNow, useSession } from "../lib/hooks";
import type { Live } from "../lib/live";
import { addStyles } from "../lib/styles";
import {
  PARTY_MINIMUM_DURATION,
  REACTIONS,
  challengeSubtitle,
  hasInLibrary,
  inviteText,
  isCompleteCode,
  partyPosition,
  partySyncLine,
  shareByline,
  shareNote,
} from "../lib/together";
import css from "./together.css";

addStyles(css);

/** Sends a Together request; says so when the background doesn't answer, and asks for fresh state. */
function useAct() {
  const model = useModel();
  const together = useLive((l) => l.together);
  return async function act<K extends UiRequestType>(type: K, payload: UiPayload<K>): Promise<UiResult<K> | null> {
    const answer = await send(type, payload, { timeoutMs: 15_000 });
    if (!answer) model.toast(NO_BACKGROUND);
    void together.live.refresh();
    return answer;
  };
}

export function TogetherView() {
  const together = useLive((l) => l.together);
  const state = together.value;

  useEffect(() => {
    void send("together.refreshChallenges", {}).then(() => together.live.refresh());
  }, []);

  return (
    <div class="together scroll">
      <div class="together-column">
        <Header state={state} />
        {state ? (
          state.isAvailable ? (
            <>
              <PartySection state={state} live={together.live} />
              <ChallengesSection state={state} />
              <SharesSection state={state} />
            </>
          ) : (
            <p class="together-note">Together needs a server address, and this build has none.</p>
          )
        ) : together.settled && !together.answered ? (
          <p class="together-note">Together runs in Cineon's background, which isn't answering yet.</p>
        ) : null}
      </div>
    </div>
  );
}

function Header({ state }: { state: TogetherSnapshot | null }) {
  const [code, setCode] = useState("");
  const act = useAct();
  const join = () => {
    if (!isCompleteCode(code)) return;
    void act("together.enter", { code });
    setCode("");
  };
  return (
    <header class="together-header">
      <h1 class="t-title">Together</h1>
      <p>
        Watch the same film at the same second, race friends to the end of a series, or send them what you've seen. Everything works with
        a six-letter code. No accounts.
      </p>
      {state?.isAvailable && (
        <div class="row" style={{ gap: "8px" }}>
          <input
            class="code-field time"
            value={code}
            placeholder="Enter a code, like K7Q-2MX"
            aria-label="Code"
            spellcheck={false}
            autoComplete="off"
            onInput={(event) => setCode((event.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") join();
            }}
          />
          <SilverButton disabled={!isCompleteCode(code) || state.isWorking} onClick={join}>
            Open
          </SilverButton>
          {state.isWorking && <Spinner />}
        </div>
      )}
    </header>
  );
}

// MARK: Party

function PartySection({ state, live }: { state: TogetherSnapshot; live: Live<TogetherSnapshot> }) {
  return state.party ? <PartyStage state={state} party={state.party} live={live} /> : <PartyInvite state={state} />;
}

/** A poster's colours behind a card, blurred into light. The only colour comes from the film. */
function StageBackground({ posterUrl }: { posterUrl: string | null | undefined }) {
  return (
    <div class="stage-background" aria-hidden="true">
      {posterUrl && <img src={posterUrl} alt="" referrerpolicy="no-referrer" />}
    </div>
  );
}

/** No party yet: what's playing, ready to share, or a nudge to start something. */
function PartyInvite({ state }: { state: TogetherSnapshot }) {
  const model = useModel();
  const session = useSession();
  const player = useLive((l) => l.player);
  const act = useAct();
  const candidate = player.value?.tab ?? null;
  const tab = candidate?.media && candidate.media.duration >= PARTY_MINIMUM_DURATION ? candidate : null;
  const title = tab?.linkedTitleId != null ? session.library.titles.get(tab.linkedTitleId) ?? null : null;
  const name = tab ? title?.name ?? tab.parsed?.name ?? tab.title : null;
  const next = session.library.continueWatching[0] ?? null;
  return (
    <section class="stage invite">
      <StageBackground posterUrl={title?.posterUrl} />
      <div class="stage-content row" style={{ gap: "22px", padding: "22px" }}>
        {title ? (
          <PosterImage title={title} width={86} keepsColour />
        ) : (
          <div class="invite-blank">
            <Icon name="play.rectangle.on.rectangle" size={28} />
          </div>
        )}
        <div class="col" style={{ gap: "8px", minWidth: 0 }}>
          <h2 class="t-title" style={{ fontSize: "26px" }}>
            Watch party
          </h2>
          <p class="invite-text">{inviteText(name)}</p>
          <div class="row" style={{ gap: "10px", marginTop: "6px" }}>
            <SilverButton large icon="person.2.wave.2" disabled={tab == null || state.isWorking} onClick={() => tab && void act("together.startParty", { tabId: tab.tabId })}>
              Start a party
            </SilverButton>
            {tab == null && next && (
              <OutlineButton onClick={() => model.resume(next.title)}>{`Open ${next.title.name}`}</OutlineButton>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The party that's on: the film and where it is, who's here, the chat and the reactions. */
function PartyStage({ state, party, live }: { state: TogetherSnapshot; party: PartyState; live: Live<TogetherSnapshot> }) {
  const model = useModel();
  const act = useAct();
  const session = useSession();
  // When this snapshot arrived, so the clock moves between them.
  const receivedAt = useMemo(() => Date.now(), [party]);
  const now = useNow(500, party.playing);
  const position = partyPosition(party, receivedAt, now);
  const myPet = session.statsAndPet().pet.code;
  void live;
  return (
    <section class="stage party">
      <StageBackground posterUrl={party.title?.posterUrl} />
      <div class="stage-content">
        <div class="row" style={{ gap: "20px", alignItems: "flex-start", padding: "22px" }}>
          <CardPoster url={party.title?.posterUrl} name={party.title?.name ?? "Party"} width={92} height={138} radius={7} />
          <div class="col" style={{ gap: "8px", minWidth: 0 }}>
            <span class="row" style={{ gap: "7px" }}>
              <span class="gold-dot" />
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--ink2)" }}>Party on</span>
            </span>
            <h2 class="t-title party-name">{party.title?.name ?? "Watch party"}</h2>
            <span style={{ fontSize: "13px", color: "var(--ink2)" }}>{partySyncLine(party, state.isHost, position)}</span>
            <span class="row" style={{ gap: "8px", marginTop: "2px", color: "var(--ink2)" }}>
              <Icon name={party.playing ? "play.fill" : "pause.fill"} size={11} />
              <span class="time" style={{ fontSize: "12px", fontWeight: 500, color: "var(--ink)" }}>
                {Timecode.string(position)}
              </span>
            </span>
          </div>
          <span class="spacer" style={{ minWidth: "12px" }} />
          <div class="col" style={{ gap: "10px", alignItems: "flex-end" }}>
            <Ticket code={party.code} onCopy={() => void model.copy(ShareCode.display(party.code), `Code ${ShareCode.display(party.code)} copied`)} />
            <div class="row" style={{ gap: "8px" }}>
              {!state.isHost && <OutlineButton onClick={() => void act("together.goToParty", {})}>Go to the film</OutlineButton>}
              <OutlineButton onClick={() => void act("together.leaveParty", {})}>{state.isHost ? "End party" : "Leave"}</OutlineButton>
            </div>
          </div>
        </div>
        <div class="members">
          {party.members.map((member) => {
            const isMe = member.personId === state.personId;
            const isHost = member.personId === party.hostId;
            return (
              <div key={member.personId} class="member" title={isHost ? `${member.name}, hosting` : member.name}>
                <span class="member-avatar">
                  <PersonAvatar name={member.name} petCode={isMe ? myPet : member.pet} isMe={isMe} size={44} />
                  {isHost && (
                    <span class="crown" aria-label="Host">
                      <Icon name="crown.fill" size={10} />
                    </span>
                  )}
                </span>
                <span class="line1" style={{ fontSize: "11.5px", fontWeight: isMe ? 600 : 400, color: "var(--ink2)", maxWidth: "60px" }}>
                  {isMe ? "You" : member.name}
                </span>
              </div>
            );
          })}
        </div>
        <div class="party-floor">
          <Chat party={party} personId={state.personId} myPet={myPet} />
          <ReactionPad party={party} />
        </div>
      </div>
    </section>
  );
}

function Chat({ party, personId, myPet }: { party: PartyState; personId: string | null; myPet: string }) {
  const act = useAct();
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const last = party.messages[party.messages.length - 1];
  const lastId = last ? PartyMessages.id(last) : null;
  useLayoutEffect(() => {
    const element = list.current;
    if (element && lastId) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [lastId]);
  const sendDraft = () => {
    const text = draft;
    if (text.trim().length === 0) return;
    setDraft("");
    void act("together.say", { text });
    field.current?.focus();
  };
  return (
    <div class="chat">
      <div class="chat-lines scroll" ref={list}>
        {party.messages.length === 0 && <p class="chat-empty">Say hello. Messages also show over the film for a moment.</p>}
        {party.messages.map((message) => (
          <ChatLine key={PartyMessages.id(message)} message={message} isMe={message.personId === personId} myPet={myPet} />
        ))}
      </div>
      <div class="chat-box">
        <input
          ref={field}
          value={draft}
          placeholder="Message everyone"
          aria-label="Message everyone"
          onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") sendDraft();
          }}
        />
        <button type="button" class="send-button" aria-label="Send" disabled={draft.trim().length === 0} onClick={sendDraft}>
          <Icon name="arrow.up" size={13} />
        </button>
      </div>
    </div>
  );
}

function ChatLine({ message, isMe, myPet }: { message: PartyMessage; isMe: boolean; myPet: string }) {
  return (
    <div class="chat-line">
      <PersonAvatar name={message.name} petCode={isMe ? myPet : message.pet} isMe={isMe} size={24} />
      <div class="col" style={{ gap: "2px", minWidth: 0 }}>
        <span class="row" style={{ gap: "6px", alignItems: "baseline" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--ink)" }}>{isMe ? "You" : message.name}</span>
          <span class="time" style={{ fontSize: "10.5px", color: "var(--ink3)" }}>
            {DateText.time(message.at / 1000)}
          </span>
        </span>
        <span class="chat-text">{message.text}</span>
      </div>
    </div>
  );
}

function ReactionPad({ party }: { party: PartyState }) {
  const act = useAct();
  const last = party.reactions[party.reactions.length - 1];
  return (
    <div class="reaction-pad">
      <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--ink3)" }}>React</span>
      <div class="reaction-grid">
        {REACTIONS.map((emoji) => (
          <HoverButton key={emoji} class="reaction" aria-label={`React ${emoji}`} onClick={() => void act("together.react", { emoji })}>
            {emoji}
          </HoverButton>
        ))}
      </div>
      {last && <span class="line1" style={{ fontSize: "11.5px", color: "var(--ink3)" }}>{`${last.name} ${last.emoji}`}</span>}
    </div>
  );
}

/** The party's code as a cinema ticket: punched edges, big numbers, click to copy. */
function Ticket({ code, onCopy }: { code: string; onCopy: () => void }) {
  const box = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setSize({ w: element.offsetWidth, h: element.offsetHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <button ref={box} type="button" class="ticket" title="Copy the code to send to friends" onClick={onCopy}>
      {size && (
        <svg class="ticket-shape" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
          <path d={ticketPath(size.w, size.h)} />
        </svg>
      )}
      <span style={{ fontSize: "10.5px", color: "var(--ink3)", position: "relative" }}>Invite code</span>
      <span class="row" style={{ gap: "8px", position: "relative" }}>
        <span class="time ticket-code">{ShareCode.display(code)}</span>
        <span style={{ color: "var(--ink3)" }}>
          <Icon name="doc.on.doc" size={13} />
        </span>
      </span>
    </button>
  );
}

/** A rounded rectangle with a half-circle punched out of each short side (TicketShape). */
export function ticketPath(w: number, h: number, radius = 8, notch = 6): string {
  const mid = h / 2;
  return [
    `M ${radius} 0 H ${w - radius} A ${radius} ${radius} 0 0 1 ${w} ${radius}`,
    `V ${mid - notch} A ${notch} ${notch} 0 0 0 ${w} ${mid + notch}`,
    `V ${h - radius} A ${radius} ${radius} 0 0 1 ${w - radius} ${h}`,
    `H ${radius} A ${radius} ${radius} 0 0 1 0 ${h - radius}`,
    `V ${mid + notch} A ${notch} ${notch} 0 0 0 0 ${mid - notch}`,
    `V ${radius} A ${radius} ${radius} 0 0 1 ${radius} 0 Z`,
  ].join(" ");
}

// MARK: Challenges

function ChallengesSection({ state }: { state: TogetherSnapshot }) {
  const model = useModel();
  return (
    <section class="col" style={{ gap: "14px" }}>
      <div class="row">
        <h2 class="t-title section-heading">Challenges</h2>
        <span class="spacer" />
        <OutlineButton icon="flag.checkered" onClick={() => model.openSheet({ kind: "newChallenge" })}>
          New challenge
        </OutlineButton>
      </div>
      {state.challenges.length === 0 ? (
        <p class="together-text">
          Pick a series or a film, send the code, and see who gets to the end first. Everyone's progress comes from what they actually watch.
        </p>
      ) : (
        <div class="col" style={{ gap: "12px" }}>
          {state.challenges.map((summary) => (
            <ChallengeCard key={summary.code} summary={summary} detail={state.details[summary.code] ?? null} personId={state.personId} />
          ))}
        </div>
      )}
    </section>
  );
}

function ChallengeCard({ summary, detail, personId }: { summary: ChallengeSummary; detail: ChallengeState | null; personId: string | null }) {
  const model = useModel();
  const act = useAct();
  const session = useSession();
  const myPet = session.statsAndPet().pet.code;
  const copy = () => void model.copy(ShareCode.display(summary.code), `Code ${ShareCode.display(summary.code)} copied`);
  return (
    <div class="challenge-card">
      <div class="row" style={{ gap: "14px", alignItems: "flex-start" }}>
        <CardPoster url={summary.title.posterUrl} name={summary.title.name} width={48} height={72} radius={5} />
        <div class="col" style={{ gap: "4px", minWidth: 0 }}>
          <span class="t-title" style={{ fontSize: "18px", color: "var(--ink)" }}>
            {summary.title.name}
          </span>
          <span style={{ fontSize: "12.5px", color: "var(--ink2)" }}>{challengeSubtitle(summary, detail, personId)}</span>
        </div>
        <span class="spacer" />
        <CodeBadge code={summary.code} onCopy={copy} />
        <button
          type="button"
          class="btn-icon"
          aria-label="More"
          {...menuButtonProps(() => (
            <>
              <MenuItem onSelect={copy}>Copy code</MenuItem>
              <MenuItem onSelect={() => void act("together.leaveChallenge", { code: summary.code })}>Leave challenge</MenuItem>
            </>
          ))}
        >
          <Icon name="ellipsis" size={16} />
        </button>
      </div>
      {detail ? (
        <div class="col" style={{ gap: "10px" }}>
          {detail.members.map((member, index) => (
            <RaceRow
              key={member.personId}
              member={member}
              place={index + 1}
              isMe={member.personId === personId}
              isWinner={member.personId === detail.winnerId}
              myPet={myPet}
            />
          ))}
        </div>
      ) : (
        <Spinner />
      )}
    </div>
  );
}

/** One person in a race: where they are, and how far. */
function RaceRow({ member, place, isMe, isWinner, myPet }: { member: ChallengeMember; place: number; isMe: boolean; isWinner: boolean; myPet: string }) {
  return (
    <div class="row" style={{ gap: "12px" }}>
      <span class="time" style={{ width: "14px", textAlign: "right", fontSize: "12px", fontWeight: 600, color: "var(--ink3)" }}>
        {place}
      </span>
      <PersonAvatar name={member.name} petCode={isMe ? myPet : member.pet} isMe={isMe} />
      <div class="col" style={{ gap: "5px", flex: "1 1 auto", minWidth: 0 }}>
        <div class="row" style={{ gap: "6px" }}>
          <span style={{ fontSize: "13px", fontWeight: isMe ? 600 : 500, color: "var(--ink)" }}>{isMe ? `${member.name} (you)` : member.name}</span>
          {isWinner && (
            <span class="gold-fill" aria-label="Winner">
              <Icon name="crown.fill" size={13} />
            </span>
          )}
          <span class="spacer" />
          <span class="line1" style={{ fontSize: "11.5px", color: "var(--ink3)" }}>
            {member.label}
          </span>
        </div>
        <ProgressLine fraction={member.fraction} height={isMe ? 5 : 4} />
      </div>
    </div>
  );
}

/** The code to read out or paste, set like a ticket number. */
export function CodeBadge({ code, onCopy }: { code: string; onCopy: () => void }) {
  return (
    <button type="button" class="code-badge" title="Copy the code" onClick={onCopy}>
      <span class="time">{ShareCode.display(code)}</span>
      <span style={{ color: "var(--ink3)" }}>
        <Icon name="doc.on.doc" size={12} />
      </span>
    </button>
  );
}

// MARK: Shares

function SharesSection({ state }: { state: TogetherSnapshot }) {
  const model = useModel();
  const session = useSession();
  const act = useAct();
  const watched = session.library.watched.length;
  return (
    <section class="col" style={{ gap: "14px" }}>
      <h2 class="t-title section-heading">Share what you've watched</h2>
      <div class="row" style={{ gap: "12px" }}>
        <OutlineButton icon="square.and.arrow.up" disabled={state.isWorking || watched === 0} onClick={() => void act("together.shareWatched", {})}>
          Share my Watched list
        </OutlineButton>
        {state.lastShareCode && (
          <CodeBadge
            code={state.lastShareCode}
            onCopy={() => void model.copy(ShareCode.display(state.lastShareCode!), `Code ${ShareCode.display(state.lastShareCode!)} copied`)}
          />
        )}
      </div>
      <p style={{ margin: 0, fontSize: "12px", color: "var(--ink3)" }}>{shareNote(watched)}</p>
      {state.openedShares.map((share) => (
        <SharedList key={share.code} share={share} />
      ))}
    </section>
  );
}

function SharedList({ share }: { share: ShareInfo }) {
  const act = useAct();
  return (
    <div class="shared-list">
      <div class="row" style={{ alignItems: "baseline" }}>
        <div class="col" style={{ gap: "2px" }}>
          <span class="t-title" style={{ fontSize: "17px", color: "var(--ink)" }}>
            {share.label}
          </span>
          <span style={{ fontSize: "12px", color: "var(--ink3)" }}>{shareByline(share.ownerName, share.titles.length)}</span>
        </div>
        <span class="spacer" />
        <button type="button" class="btn-plain" style={{ fontSize: "12px", color: "var(--ink2)" }} onClick={() => void act("together.forgetShare", { code: share.code })}>
          Close
        </button>
      </div>
      <div class="shared-row hscroll">
        {share.titles.map((card, index) => (
          <SharedPoster key={`${card.imdbId ?? card.name}-${index}`} card={card} />
        ))}
      </div>
    </div>
  );
}

function SharedPoster({ card }: { card: TitleCard }) {
  const session = useSession();
  const act = useAct();
  const [hovered, hover] = useHover();
  const have = hasInLibrary(card, session.library.titles);
  return (
    <div class="shared-poster" {...hover}>
      <div class="shared-art">
        <RemoteImage url={card.posterUrl} placeholder={<PosterPlaceholder name={card.name} />} style={{ position: "absolute", inset: "0" }} />
        {(hovered || have) && (
          <button
            type="button"
            class="add-circle"
            title={have ? "In your library" : "Add to backlog"}
            aria-label={have ? "In your library" : "Add to backlog"}
            disabled={have}
            onClick={() => void act("together.addToBacklog", { card })}
          >
            <Icon name={have ? "checkmark" : "plus"} size={13} />
          </button>
        )}
      </div>
      <span class="line2" style={{ fontSize: "11.5px", fontWeight: 500, color: "var(--ink2)", width: "96px" }}>
        {card.name}
      </span>
      {card.rating != null && card.rating > 0 && <StarRow halves={Math.min(20, card.rating)} size={7.5} spacing={0.5} />}
    </div>
  );
}
