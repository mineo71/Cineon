declare const __TARGET__: "chrome" | "firefox";
declare const __VERSION__: string;
declare module "@page/*" {
  const source: string;
  export default source;
}
