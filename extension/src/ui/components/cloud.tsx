// CloudStatus (ProfileView.swift): whether ratings and lists are safe in the cloud. On the Profile
// page and in Settings. The backup runs in the background, so with no answer it says so.

import { useLive, useSession } from "../lib/hooks";
import { cloudStatus } from "../lib/profileText";
import { Icon } from "./Icon";

export function CloudStatus() {
  const session = useSession();
  const together = useLive((l) => l.together);
  const status = cloudStatus(session.settings.cloudBackup, together.value?.cloud ?? null, together.answered || !together.settled);
  return (
    <span
      class="row"
      style={{ gap: "6px", fontSize: "11.5px", color: "var(--ink3)", minWidth: "0" }}
      title="Ratings and lists are kept in the cloud, so they come back if you clear the library or move to another computer."
    >
      <Icon name={status.icon} size={14} />
      <span class="line1">{status.text}</span>
    </span>
  );
}
