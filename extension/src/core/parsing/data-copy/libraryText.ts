// One copy: the data layer's.
import { LibraryText } from "../../data/libraryText";

export function normalize(s: string): string {
  return LibraryText.normalize(s);
}
