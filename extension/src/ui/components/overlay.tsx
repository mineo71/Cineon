// RootView's overlay pieces, shared by the screens that put something over the page: the dimmed
// backdrop with its card (DimmedBackdrop), and the toast at the bottom (ToastHost).

import type { ComponentChildren } from "preact";
import { useModel, useUi } from "../lib/hooks";

/** DimmedBackdrop and the card above it, centred or near the top (the command bar). */
export function Overlay({
  children,
  onDismiss,
  strength = 0.5,
  align = "center",
}: {
  children: ComponentChildren;
  onDismiss: () => void;
  strength?: number;
  align?: "center" | "top";
}) {
  return (
    <div class="overlay">
      <div class="dim" style={{ background: `rgba(0,0,0,${strength})` }} onClick={onDismiss} />
      <div class={`overlay-${align}`}>{children}</div>
    </div>
  );
}

/** ToastHost: one at a time, at the bottom, in glass. */
export function ToastHost() {
  const model = useModel();
  const ui = useUi();
  const toast = ui.toast;
  if (!toast) return null;
  return (
    <div class="toast-host" role="status" aria-live="polite">
      <div class="toast glass" key={toast.id}>
        <span class="message">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            class="btn-link"
            onClick={() => {
              toast.action!.run();
              model.dismissToast();
            }}
          >
            {toast.action.title}
          </button>
        )}
      </div>
    </div>
  );
}
