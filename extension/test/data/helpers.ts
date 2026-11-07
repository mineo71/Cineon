import { Database, LibraryText, Title } from "../../src/core/data";

let counter = 0;

/** A new, empty profile database with a name no other test uses. */
export function freshDatabase(): Promise<Database> {
  counter++;
  return Database.open(`cineon-test-${counter}-${Math.random().toString(36).slice(2)}`);
}

export function makeTitle(name = "Dune", fields: Partial<Title> = {}): Title {
  const now = Date.now() / 1000;
  return Title.make({
    name,
    normName: LibraryText.normalize(name),
    year: 2021,
    kind: "film",
    status: "backlog",
    posterUrl: "https://x.example/p.jpg",
    genres: ["Sci-Fi", "Drama"],
    runtimeMinutes: 155,
    addedAt: now,
    updatedAt: now,
    ...fields,
  });
}
