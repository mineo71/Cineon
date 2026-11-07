// Theme.swift's button styles and the settings controls, as Preact components.

import type { CSSProperties, ComponentChildren, ButtonHTMLAttributes, Ref } from "preact";
import { Icon } from "./Icon";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "icon" | "size"> & {
  icon?: string;
  large?: boolean;
  disabled?: boolean;
  children?: ComponentChildren;
};

function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** The one strong button on any screen (SilverButtonStyle). */
export function SilverButton({ icon, large, class: className, children, ...rest }: ButtonProps) {
  return (
    <button type="button" class={cls("btn-silver", large && "large", className as string)} {...rest}>
      {icon && <Icon name={icon} size={large ? 15 : 13} />}
      {children}
    </button>
  );
}

/** OutlineButtonStyle. */
export function OutlineButton({ icon, large, class: className, children, ...rest }: ButtonProps) {
  return (
    <button type="button" class={cls("btn-outline", large && "large", className as string)} {...rest}>
      {icon && <Icon name={icon} size={large ? 15 : 13} />}
      {children}
    </button>
  );
}

/** HoverButtonStyle: no fill until hovered, raised2 when selected or pressed. */
export function HoverButton({
  selected,
  class: className,
  children,
  ...rest
}: Omit<ButtonProps, "icon" | "large"> & { selected?: boolean }) {
  return (
    <button type="button" class={cls("btn-hover", selected && "selected", className as string)} aria-pressed={selected} {...rest}>
      {children}
    </button>
  );
}

/** IconButton: a 16 pt symbol in ink2 with a 5 pt hover pad. */
export function IconButton({
  icon,
  label,
  size = 13,
  disabled,
  onClick,
  class: className,
  selected,
  buttonRef,
  ...rest
}: {
  icon: string;
  label: string;
  size?: number;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
  class?: string;
  selected?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "icon" | "size" | "label" | "onClick" | "class">) {
  return (
    <button
      type="button"
      ref={buttonRef}
      class={cls("btn-icon", selected && "selected", className)}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      {...rest}
    >
      <Icon name={icon} size={Math.round(size * 1.2)} />
    </button>
  );
}

/** A switch (`.toggleStyle(.switch)`), tinted silver in dark and black in white. */
export function Switch({
  on,
  onChange,
  label,
  mini,
  disabled,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
  label: string;
  mini?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      class={cls("switch", on && "on", mini && "mini")}
      onClick={() => onChange(!on)}
    />
  );
}

/** SettingToggle: a label and its note on the left, the switch on the right. */
export function SettingToggle({
  label,
  detail,
  on,
  onChange,
}: {
  label: string;
  detail?: string | null;
  on: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label class="setting-toggle">
      <span class="col" style={{ gap: "1px", flex: "1 1 auto", minWidth: 0 }}>
        <span style={{ fontSize: "13px", color: "var(--ink)" }}>{label}</span>
        {detail && <span style={{ fontSize: "12px", color: "var(--ink3)" }}>{detail}</span>}
      </span>
      <Switch on={on} onChange={onChange} label={label} />
    </label>
  );
}

/** SettingSlider: label, a 180 pt slider, the value in 58 pt. */
export function SettingSlider({
  label,
  valueText,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  valueText: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div class="row" style={{ gap: "12px" }}>
      <span style={{ fontSize: "13px", color: "var(--ink)" }}>{label}</span>
      <span class="spacer" />
      <input
        type="range"
        class="slider"
        aria-label={label}
        min={min}
        max={max}
        step={step ?? "any"}
        value={value}
        style={{ width: "180px", "--fill": fill } as CSSProperties}
        onInput={(event) => onChange(Number((event.currentTarget as HTMLInputElement).value))}
      />
      <span class="time" style={{ width: "58px", textAlign: "right", fontSize: "12px", color: "var(--ink2)" }}>
        {valueText}
      </span>
    </div>
  );
}

/** A checkbox in the chrome's silver (`.toggleStyle(.checkbox)` with the silver tint). */
export function Checkbox({
  on,
  onChange,
  children,
  disabled,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
  children?: ComponentChildren;
  disabled?: boolean;
}) {
  return (
    <label class="row" style={{ gap: "8px", flex: "1 1 auto", minWidth: 0, opacity: disabled ? 0.5 : 1 }}>
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        disabled={disabled}
        class={cls("check", on && "on")}
        onClick={() => onChange(!on)}
      >
        {on && <Icon name="checkmark" size={11} />}
      </button>
      {children}
    </label>
  );
}

/** A pop-up picker (Picker with `.menu` style). */
export function Picker<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  style,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <select
      class="select"
      aria-label={label}
      disabled={disabled}
      value={String(value)}
      style={style}
      onChange={(event) => {
        const raw = (event.currentTarget as HTMLSelectElement).value;
        const match = options.find((o) => String(o.value) === raw);
        if (match) onChange(match.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** InputField: 38 pt, raised, 9 pt corners. */
export function TextField({
  value,
  onInput,
  onSubmit,
  placeholder,
  autoFocus,
  small,
  inputRef,
  style,
  class: className,
  mono,
  label,
}: {
  value: string;
  onInput: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  small?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  style?: CSSProperties;
  class?: string;
  mono?: boolean;
  label?: string;
}) {
  return (
    <input
      ref={inputRef}
      class={cls("field", small && "small", mono && "time", className)}
      value={value}
      placeholder={placeholder}
      aria-label={label ?? placeholder}
      autoFocus={autoFocus}
      spellcheck={false}
      autoComplete="off"
      style={style}
      onInput={(event) => onInput((event.currentTarget as HTMLInputElement).value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && onSubmit) {
          event.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

/** The library's and timeline's find field: a magnifying glass and a plain field in a capsule. */
export function SearchCapsule({
  value,
  onInput,
  placeholder,
  width = 130,
  rounded = "capsule",
}: {
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
  width?: number;
  rounded?: "capsule" | "rect";
}) {
  return (
    <label class="capsule-field" style={rounded === "rect" ? { borderRadius: "8px" } : undefined}>
      <Icon name="magnifyingglass" size={13} />
      <input
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        spellcheck={false}
        style={{ width: `${width}px` }}
        onInput={(event) => onInput((event.currentTarget as HTMLInputElement).value)}
      />
    </label>
  );
}

/** ProgressView().controlSize(.small). */
export function Spinner({ size = 16 }: { size?: number }) {
  return <span class="spinner" role="progressbar" aria-label="Working" style={{ width: `${size}px`, height: `${size}px` }} />;
}
