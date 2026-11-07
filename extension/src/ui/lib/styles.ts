// Adds a screen's stylesheet to the page once. Screens import their CSS as text
// (`import css from "./home.css"`) and call `addStyles(css)` at module level, so the rules are in
// before the first render. ui.css (linked in the page) has the tokens and shared components.

const added = new Set<string>();

export function addStyles(text: string | undefined | null): void {
  if (!text || typeof text !== "string" || added.has(text) || typeof document === "undefined") return;
  added.add(text);
  const style = document.createElement("style");
  style.textContent = text;
  document.head.appendChild(style);
}
