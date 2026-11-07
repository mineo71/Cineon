// The toolbar popup (popup.html).
import { render } from "preact";
import { Popup } from "./screens/Popup";
import { applyRememberedTheme } from "./lib/session";

document.documentElement.dataset.mode = "popup";
applyRememberedTheme();
render(<Popup />, document.getElementById("root")!);
