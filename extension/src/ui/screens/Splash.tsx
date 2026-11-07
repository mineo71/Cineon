// Splash.swift: the one orchestrated moment. The logo's film strip unspools around the C: a wipe
// from the top end of the C round to the bottom end (0.42 s), a moment's hold, then it fades
// (0.22 s from 0.54 s). Drawn over the page, so nothing waits for it. Also where the page asks
// who's watching when it opens (AppModel.init: askOnLaunch with more than one person).

import { useEffect, useState } from "preact/hooks";
import { useModel, useReducedMotion, useSession } from "../lib/hooks";
import { addStyles } from "../lib/styles";
import css from "./splash.css";

addStyles(css);

/** Once per page load, whatever re-renders. */
let played = false;
let asked = false;

export function Splash() {
  const model = useModel();
  const session = useSession();
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(() => !played && session.settings.launchAnimation && !reduceMotion);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    played = true;
    if (!asked) {
      asked = true;
      const isPanel = typeof document !== "undefined" && document.documentElement.dataset.mode === "panel";
      if (!isPanel && session.profiles.askOnLaunch && session.profiles.profiles.length > 1) model.showProfilePicker(true);
    }
    if (!visible) return;
    const fade = setTimeout(() => setFading(true), 540);
    const done = setTimeout(() => setVisible(false), 540 + 240);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, []);

  if (!visible) return null;
  return (
    <div class={`splash${fading ? " fading" : ""}`} aria-hidden="true">
      <span class="splash-logo" />
    </div>
  );
}
