// The little of Node the parity test uses to read the committed corpus. The project doesn't install
// @types/node; if it ever does, these merge with its declarations.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function writeFileSync(path: string | URL, data: string): void;
}
