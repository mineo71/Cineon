// SwiftUI's confirmationDialog: a small card asking before something can't be undone. Shown in
// the page's menu layer (components/menu.tsx), so Esc and a click outside cancel it without
// closing what's underneath.

import { openMenu } from "./menu";
import { addStyles } from "../lib/styles";

addStyles(`
.confirm { width: 340px; padding: 20px; display: flex; flex-direction: column; gap: 8px; }
.confirm h2 { margin: 0; font: 600 14px var(--ui); color: var(--ink); }
.confirm p { margin: 0; font-size: 12.5px; color: var(--ink2); line-height: 1.35; }
.confirm .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.confirm .destructive { color: rgb(255,99,99); box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(255,99,99) 45%, transparent); }
:root[data-theme="white"] .confirm .destructive { color: rgb(215,0,21); box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(215,0,21) 40%, transparent); }
`);

export interface ConfirmOptions {
  /** "Delete all saved frames?" */
  readonly title: string;
  /** What happens, and what stays. */
  readonly message?: string;
  /** The button that does it: "Delete frames and moments". */
  readonly confirm: string;
  /** Red, for what can't be undone. Default true. */
  readonly destructive?: boolean;
}

/** Asks; true when the person pressed the confirm button. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;
    const width = 340;
    const left = Math.max(8, (globalThis.innerWidth ?? 800) / 2 - width / 2);
    const top = Math.max(60, (globalThis.innerHeight ?? 600) * 0.28);
    const anchor = { left, right: left + width, top, bottom: top, width, height: 0, x: left, y: top } as DOMRect;
    openMenu(
      anchor,
      (close) => (
        <div class="confirm" role="alertdialog" aria-label={options.title}>
          <h2>{options.title}</h2>
          {options.message && <p>{options.message}</p>}
          <div class="buttons">
            <button type="button" class="btn-outline" onClick={close} autoFocus>
              Cancel
            </button>
            <button
              type="button"
              class={`btn-outline${options.destructive === false ? "" : " destructive"}`}
              onClick={() => {
                confirmed = true;
                close();
              }}
            >
              {options.confirm}
            </button>
          </div>
        </div>
      ),
      { kind: "popover", label: options.title, onClose: () => resolve(confirmed) },
    );
  });
}

/** The same, as a hook, for components that like hooks. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirmDialog;
}
