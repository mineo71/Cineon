// Vite's "?raw" imports: a file's text. The filter lists come in this way, so the tests need no Node typings.
declare module "*?raw" {
  const text: string;
  export default text;
}
