// `import run from "@page-run/media.js"`: the Mac's page script wrapped in a function by
// scripts/build.mjs, so it runs inside the content script without evaluating a string.
declare module "@page-run/*" {
  const run: () => void;
  export default run;
}
