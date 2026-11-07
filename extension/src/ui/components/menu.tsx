// Menus, context menus and popovers (SwiftUI's Menu, .contextMenu and .popover). One layer at the
// page's root shows at most one at a time, positioned against the button or the pointer and
// kept on screen. Esc, a click outside or picking an item closes it.

import type { CSSProperties, ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";

export type Anchor = { readonly x: number; readonly y: number } | DOMRect;

interface Open {
  readonly id: number;
  readonly anchor: Anchor;
  readonly kind: "menu" | "popover";
  readonly render: (close: () => void) => ComponentChildren;
  readonly onClose: (() => void) | null;
  readonly label: string;
}

let current: Open | null = null;
let ids = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Opens a menu (or popover) at a button's rectangle or a point. */
export function openMenu(
  anchor: Anchor,
  render: (close: () => void) => ComponentChildren,
  options: { kind?: "menu" | "popover"; onClose?: () => void; label?: string } = {},
): void {
  current?.onClose?.();
  current = { id: ++ids, anchor, render, kind: options.kind ?? "menu", onClose: options.onClose ?? null, label: options.label ?? "Menu" };
  emit();
}

export function closeMenu(): void {
  if (!current) return;
  const closing = current;
  current = null;
  closing.onClose?.();
  emit();
}

export function isMenuOpen(): boolean {
  return current != null;
}

function isRect(anchor: Anchor): anchor is DOMRect {
  return "width" in anchor;
}

/** Where a box of this size goes: under the anchor, or above it when there's no room; inside the window. */
export function placeMenu(anchor: Anchor, width: number, height: number, viewport: { width: number; height: number }) {
  const margin = 8;
  let x: number;
  let y: number;
  if (isRect(anchor)) {
    x = anchor.left;
    y = anchor.bottom + 6;
    if (y + height > viewport.height - margin && anchor.top - 6 - height >= margin) y = anchor.top - 6 - height;
    if (x + width > viewport.width - margin) x = anchor.right - width;
  } else {
    x = anchor.x;
    y = anchor.y;
    if (y + height > viewport.height - margin) y = Math.max(margin, anchor.y - height);
  }
  x = Math.max(margin, Math.min(x, viewport.width - width - margin));
  y = Math.max(margin, Math.min(y, viewport.height - height - margin));
  return { x, y };
}

/** Put once at the page's root. */
export function MenuLayer() {
  const [, setTick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const listener = () => {
      setPosition(null);
      setTick((n) => n + 1);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const open = current;

  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    setPosition(placeMenu(open.anchor, rect.width, rect.height, { width: innerWidth, height: innerHeight }));
  }, [open?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      }
    };
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) closeMenu();
    };
    const onBlur = () => closeMenu();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [open?.id]);

  if (!open) return null;
  const style: CSSProperties = position
    ? { left: `${position.x}px`, top: `${position.y}px` }
    : { left: "0px", top: "0px", visibility: "hidden" };
  return (
    <div
      ref={box}
      class={open.kind}
      style={style}
      role={open.kind === "menu" ? "menu" : "dialog"}
      aria-label={open.label}
      onContextMenu={(event) => event.preventDefault()}
    >
      {open.render(closeMenu)}
    </div>
  );
}

/** A menu row. `checked` shows a tick (a Toggle in a Menu). */
export function MenuItem({
  onSelect,
  checked,
  disabled,
  destructive,
  children,
  keepOpen,
}: {
  onSelect: () => void;
  checked?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  children: ComponentChildren;
  keepOpen?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      class={`menu-item${destructive ? " destructive" : ""}`}
      onClick={() => {
        if (!keepOpen) closeMenu();
        onSelect();
      }}
    >
      {checked && <Icon name="checkmark" size={12} class="tick" />}
      {children}
    </button>
  );
}

export function MenuDivider() {
  return <div class="menu-divider" role="separator" />;
}

export function MenuHeader({ children }: { children: ComponentChildren }) {
  return <div class="menu-header">{children}</div>;
}

/** Props for a button that opens a menu under itself. */
export function menuButtonProps(
  render: (close: () => void) => ComponentChildren,
  options: { kind?: "menu" | "popover"; label?: string } = {},
) {
  return {
    "aria-haspopup": "menu" as const,
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      const target = event.currentTarget as HTMLElement;
      openMenu(target.getBoundingClientRect(), render, options);
    },
  };
}

/** `.contextMenu { … }`: right-click opens the menu at the pointer. */
export function contextMenuProps(render: (close: () => void) => ComponentChildren) {
  return {
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu({ x: event.clientX, y: event.clientY }, render);
    },
  };
}
