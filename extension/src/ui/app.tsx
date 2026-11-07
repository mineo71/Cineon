// The Cineon page (app.html), and the side panel / Firefox sidebar (app.html#panel).
import { render } from "preact";
import { Root } from "./Root";
import { applyRememberedTheme } from "./lib/session";

const mode = location.hash.startsWith("#panel") ? "panel" : "app";
document.documentElement.dataset.mode = mode;
applyRememberedTheme();
render(<Root mode={mode} />, document.getElementById("root")!);
