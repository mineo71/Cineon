// Runs in every frame, in the extension's isolated world (the Mac's private script world).
import media from "@page/media.js";
import meta from "@page/meta.js";
import { installHandlers } from "./shim";

installHandlers((message, wantsReply) => {
  if (!wantsReply) {
    chrome.runtime.sendMessage(message).catch(() => {});
    return;
  }
  return chrome.runtime.sendMessage(message);
});

// The scripts are plain source, bundled as strings so they stay byte-for-byte the Mac's.
// TODO(ext-runtime): evaluate media.js and meta.js here (see notes/runtime.md once written).
void media;
void meta;
