// The service worker: tracker, autopilot, rescue, shields, downloads, Together.
// TODO(ext-runtime): everything; see PLAN.md.
chrome.runtime.onInstalled.addListener(() => {
  console.info("Cineon installed", __VERSION__);
});
