# Cineon Together server

A small [Convex](https://convex.dev) backend for Cineon's Together features: share codes, watch
parties (with chat) and challenges, plus a backup of each person's ratings and library statuses. The contract is in
`../docs/superpowers/specs/2026-11-03-downloads-watch-modes-together.md` (section 3).

The app calls it only through Convex's HTTP API. It needs no SDK:

```sh
curl -X POST "$CONVEX_URL/api/query" -H 'Content-Type: application/json' \
  -d '{"path":"codes:resolve","args":{"code":"K7Q-2MX"},"format":"json"}'
# {"status":"success","value":{"kind":"party"}}
```

Mutations go to `/api/mutation`. Every write takes `deviceSecret`. There are no accounts. The
server stores only the hex SHA-256 of the secret's UTF-8 bytes (the base64 string as sent), in
`people.secretHash`.

Errors come back as `{"status":"error","errorMessage":"…","errorData":{"code":"…","message":"…"}}`.
The `code` is one of `INVALID_ARGUMENT`, `UNKNOWN_DEVICE`, `NOT_FOUND`, `NOT_MEMBER`, `NOT_HOST` or
`PARTY_ENDED`. Because these are `ConvexError`s, `errorData` also reaches the client in production.

Numbers come back as JSON floats (`2022.0`), since Convex stores them as float64.

`parties:get`, `challenges:get` and `library:all` take an optional `t` that they ignore. Convex caches a query's
result until something it read is written, which would freeze `now`, and the 30 s presence and 10 s
reaction windows, between host updates. Clients send the current time as `t` on every poll so each
one runs fresh. Members call `parties:heartbeat` every few seconds to stay in `members`;
`parties:say` counts as one too.

People can carry a `pet` (a short avatar code, 1 to 48 of `[A-Za-z0-9_-]`) set through
`people:register`; leaving it out (or `null`) keeps the stored one and `""` removes it. Views look it up at read time, so every
`pet` in a response is the person's current one, or `null`.

Party chat lives in `messages`. `parties:say` caps text at 280 characters and allows 5 messages per
person per 5 s; `parties:get` returns the latest 50, oldest first. Messages aren't pruned.

The library backup lives in `libraryItems`, one row per (person, `key`). `library:put` upserts up to
200 items per call; `rating` and `status` are last-write-wins on `ratedAt` / `statusAt` (a missing
time loses to any stored one, and clearing keeps its time as a tombstone). `library:all` returns all
of a person's rows at once, which stays inside Convex's per-query limits (32,000 documents, 16 MiB)
up to roughly 30,000 titles. The identity is just the device secret: reusing it elsewhere (a
recovery code) gives the same `personId`.

## Layout

- `convex/schema.ts`: tables and indexes.
- `convex/lib.ts`: secret hashing, person lookup (and `peopleReader`, which reads each person once
  per view), code generation and normalisation, string capping, pet validation, the `TitleCard`
  validator.
- `convex/people.ts`, `codes.ts`, `shares.ts`, `parties.ts`, `challenges.ts`, `library.ts`: the
  functions.

## Deploy

```sh
npm install
npx convex dev --once   # push to the dev deployment named in .env.local
npx convex deploy       # push to the production deployment
npm run typecheck
```

`.env.local` is written by the CLI and is not committed. To set up a fresh checkout against the
existing project, run `npx convex dev --once --configure existing --team olehrylskyj --project cineon`.

## Deployment

- Project: `cineon` (team `olehrylskyj`). Dashboard: https://dashboard.convex.dev/t/olehrylskyj/cineon
- Dev deployment `stoic-pelican-635`. URL: **https://stoic-pelican-635.eu-west-1.convex.cloud**
  (`CINEON_TOGETHER_URL` for Debug builds and the end-to-end tests).
- Production deployment `admired-mouse-481`. URL: **https://admired-mouse-481.eu-west-1.convex.cloud**
  (`CINEON_TOGETHER_URL` for Release builds, which is what people install). Run `npx convex deploy`
  after changing the functions, before releasing an app that needs them.
