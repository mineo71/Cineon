// Screen stylesheets are bundled as text (esbuild's `.css: text` loader) and added by `addStyles`.
declare module "*.css" {
  const text: string;
  export default text;
}
