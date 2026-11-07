// ProfilePicker.swift: "Who's watching?" Each person's card is the poster of the last thing they
// watched, so the picker is a little portrait of the family's taste.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Profile } from "../../core/data";
import { confirmDialog } from "../components/confirm";
import { Icon } from "../components/Icon";
import { OutlineButton, SilverButton } from "../components/controls";
import { ProfileAvatar, RemoteImage } from "../components/media";
import { useModel, useSession } from "../lib/hooks";
import { latestPosterUrl } from "../lib/settings";
import { addStyles } from "../lib/styles";
import css from "./picker.css";

addStyles(css);

export function ProfilePicker() {
  const model = useModel();
  const session = useSession();
  const [isAdding, setAdding] = useState(false);
  const [isEditing, setEditing] = useState(false);
  const profiles = session.profiles.profiles;
  return (
    <div class="profile-picker" role="dialog" aria-label="Who's watching?">
      <div class="picker-column">
        <h1 class="t-title picker-title">Who's watching?</h1>
        <div class="picker-cards">
          {profiles.map((profile) => (
            <ProfileCard key={profile.id} profile={profile} isEditing={isEditing} />
          ))}
          <AddCard isAdding={isAdding} setAdding={setAdding} />
        </div>
        <div class="row" style={{ gap: "10px" }}>
          {profiles.length > 1 && <OutlineButton onClick={() => setEditing(!isEditing)}>{isEditing ? "Done" : "Edit profiles"}</OutlineButton>}
          <OutlineButton onClick={() => model.showProfilePicker(false)}>Close</OutlineButton>
        </div>
      </div>
    </div>
  );
}

function AddCard({ isAdding, setAdding }: { isAdding: boolean; setAdding: (value: boolean) => void }) {
  const model = useModel();
  const session = useSession();
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isAdding) field.current?.focus();
  }, [isAdding]);
  const add = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const profile = await session.profiles.add(trimmed);
    session.notifyProfiles();
    setName("");
    setAdding(false);
    await model.switchProfile(profile.id);
  };
  return (
    <div class="picker-card">
      {isAdding ? (
        <div class="add-form">
          <input
            ref={field}
            class="add-name"
            value={name}
            placeholder="Name"
            aria-label="Name"
            onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void add();
            }}
          />
          <SilverButton onClick={() => void add()}>Add</SilverButton>
        </div>
      ) : (
        <button type="button" class="add-card" aria-label="Add a profile" onClick={() => setAdding(true)}>
          <Icon name="plus" size={28} />
        </button>
      )}
      <span class="picker-name ink3">Add someone</span>
    </div>
  );
}

function ProfileCard({ profile, isEditing }: { profile: Profile; isEditing: boolean }) {
  const model = useModel();
  const session = useSession();
  const isCurrent = session.profile.id === profile.id;
  const posterUrl = isCurrent ? latestPosterUrl(session.library) ?? profile.lastPosterUrl : profile.lastPosterUrl;
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete ${profile.name}'s profile?`,
      message: "Their library, timeline and settings are removed for good.",
      confirm: "Delete profile and all its data",
    });
    if (!ok) return;
    await session.profiles.delete(profile.id);
    session.notifyProfiles();
  };
  return (
    <div class="picker-card">
      <button type="button" class="profile-poster" aria-label={profile.name} onClick={() => void model.switchProfile(profile.id)}>
        <RemoteImage
          url={posterUrl}
          class="profile-art"
          placeholder={
            <span class="profile-blank">
              <ProfileAvatar name={profile.name} size={64} />
            </span>
          }
        />
        {posterUrl && (
          <span class="profile-badge">
            <ProfileAvatar name={profile.name} size={30} />
          </span>
        )}
      </button>
      <span class={`picker-name${isCurrent ? " current" : ""}`}>{profile.name}</span>
      {isEditing && session.profiles.profiles.length > 1 && !isCurrent && <OutlineButton onClick={() => void remove()}>Delete</OutlineButton>}
    </div>
  );
}
