# RemoteOps — Backend

The server-side system for the [RemoteOps frontend](../remote-ops-frontend).

A REST API in **Node.js + TypeScript** over **PostgreSQL**, with cookie-based authentication
and per-user data isolation. It replaces the frontend's `localStorage` layer, and it moves the
domain's business rules from the client — where they were suggestions — onto the server, where
they are enforced.

---

## 1. Why this exists

The frontend was a **browser-only** application: no API, no accounts, all data in
`localStorage` under four keys (`bm_bids`, `bm_profile`, `bm_settings`, `bm_initialized`).
That design capped the product in three concrete ways:

1. **Single device.** Data lived in one browser profile. Clearing site data destroyed it, and
   there was no way to open the same job search on a phone or a second machine.
2. **~5 MB ceiling.** Browser storage is bounded, and the app had no import path for the JSON
   backup it exported — so a backup could not be restored.
3. **Single user.** There was no identity, so nothing could be shared, delegated, or audited.

All three are addressed below: accounts and per-user isolation (§6.1), a real database (§5),
and a working import to match the existing export (§6.8).

## 2. Scope

**In scope, and implemented**

- Authentication and per-user data isolation
- CRUD over the domain model in §3, with server-side ownership checks
- Persistence in PostgreSQL, with migrations
- Import/export of a user's full dataset, closing the frontend's one-way export gap
- The aggregate queries the Dashboard needs — status breakdown, daily bid volume, activity
  heatmap, upcoming interviews, started contracts — computed server-side rather than over a
  full client fetch
- Reading a job posting from its public URL and returning it as Markdown, so the application
  form fills its own description field (§6.3)
- Writing a Resume for one application with an AI platform, storing it with the bid, and
  rendering it as a PDF or a Word file (§6.4)
- Writing the cover letter that goes with it, from that Resume and the same posting, stored
  and rendered on identical terms (§6.4)
- A conversation about one application — the extra questions an employer's form asks beside
  the Resume — streamed as it is written, and stored with the application (§6.4)

**Out of scope for v1**

- Authenticated job-board integrations — the parser in §6.3 reads pages a browser can see without signing in, with no
  accounts, no API keys and no stored postings
- Email and push notifications
- Editing the Resume after it is generated. What the AI returns is what is rendered, and
  regenerating replaces it. The *answers* to an application's questions are the exception —
  those are edited on the form before they are saved (§6.4)
- An admin screen for choosing the AI platform, holding its key and picking a model. The
  provider, the key and the model come from the environment for now; the route the picker will
  read its options from does exist (§6.4)
- Multi-tenant organisations, roles, or sharing between users

## 3. Domain model

Mirrors the frontend's `src/lib/types.ts`. A **bid** is one job application and the only
first-class entity; every screen is a view over the same collection.

| Field | Type | Notes |
| --- | --- | --- |
| `company`, `role` | string | Required |
| `jobUrl` | string? | Link to the posting |
| `location` | string | Free text, e.g. `Remote, TX` |
| `jobDescription` | string? | The pasted job posting |
| `rateType` | `hourly` \| `annually` | Legacy — read for display, no longer captured by the UI |
| `rateAmount` | number? | Legacy — the rate *asked for* |
| `bidDate` | date | Submission date |
| `status` | enum (§3.1) | Funnel position |
| `followUpDate` | date? | |
| `resumeVersion` | string? | Free-text label of which Resume was sent |
| `candidate` | object | Read-only: `userId`, `firstName`, `lastName`, `displayName` and a signed `photoUrl`. Who the application is filed under — always the caller for a plain account, any profile in an admin's list |
| `resumeDocument` | json? | The Resume generated for this application, as the JSON the template renders (§6.4). Exposed on the wire as a `hasResume` flag, never as the document |
| `coverLetterDocument` | json? | The cover letter written for this application, as the JSON its template renders (§6.4). Exposed on the wire as a `hasCoverLetter` flag, never as the letter |
| `applicationChat` | json? | The conversation held while filling in this application's form: `[{ role, content }]` (§6.4). Exposed on the wire as a `chatMessageCount`, never as the transcript |
| `notes` | string? | |
| `interviews` | `InterviewRound[]` | One per interview stage reached, each with date/time |
| `commitmentDetails` | object? | Start/end date, contract type (e.g. `1099`), agreed rate |
| `createdAt`, `updatedAt` | timestamp | Server-maintained |

Alongside bids, each user owns one **profile** (contact details, photo, work history,
education) and one **settings** record (daily bid goal, theme).

A user also carries a **role** — `user` or `admin`, and it now decides more than which screens
the frontend offers:

| | `user` | `admin` |
| --- | --- | --- |
| Sees | their own applications | every profile's |
| Creates an application | for themselves | for any profile (`userId` on the payload) |
| Changes an application's status | no | yes |
| Deletes an application | no | yes |
| Edits everything else about their own | yes | yes |
| Manages accounts and profiles (§6.9) | no | yes |
| Sets the daily bid goal and the AI settings (§6.10) | no | yes |

There is no self-service route to `admin`; see §6.5 for how to promote one. Ownership is still
what scopes a plain account's every query — the admin's scope is simply empty, which is
`ownerScope()` in [`src/auth/actor.ts`](src/auth/actor.ts).

### 3.1 The funnel

```
Draft → Applied → Screening (Round 1) → Interview (Round 2) → Interview (Round 3)
      → Final Interview → Offer → Background Check Passed → Started → Completed

Failed, Expired, Other  (closed — reachable from any stage)
```

`Expired` is a posting that was taken down or stopped accepting applications; `Other` is any
ending the rest do not name.

Every application also carries a `number`: its place in the order applications were filed
within its Profile (or within its owner's own rows when it has no Profile), counted up from 1.
It is assigned on create and never reused, so a deleted application leaves a gap.

`Screening (Round 1)`, `Interview (Round 2)`, `Interview (Round 3)` and `Final Interview` are
**interview stages**.

These strings are the wire format. In Postgres they are a `bid_status` enum whose stored
values are those exact strings; the generated TypeScript names are SCREAMING_CASE, because
Prisma enum members cannot contain spaces. [`src/domain/status.ts`](src/domain/status.ts) is
the only place that bridges the two.

### 3.2 Business rules the API enforces

These were enforced in the frontend. Moving them server-side is the point of having a server.
Each has a test named after it in [`tests/bids.test.ts`](tests/bids.test.ts).

1. **An interview stage cannot be entered without a scheduled date and time.** `POST` and
   `PATCH` reject the transition with `422` unless the resulting bid has an interview round
   whose `stage` equals its new `status`. The bulk endpoint requires `interviewDateTime`.
2. **Entering an interview stage creates or overwrites that stage's interview round.**
   Enforced by a `UNIQUE (bid_id, stage)` constraint, not by application code alone, so
   re-entering a stage cannot produce a duplicate round even under a race.
3. **Transitions are not order-constrained.** Any status may move to any other. The funnel is
   the intended narrative, not a state machine.
4. **A commitment is a bid with status `Started` or `Completed`.**
   `commitmentDetails.agreedRate` overrides `rateAmount` for display — the dashboard's
   `startedContracts[].rate` applies this.
5. **The profile is global per user, not per bid.** A bid carries only a free-text
   `resumeVersion` label.

### 3.3 Dates

Four formats, and the distinction matters:

| Kind | Format | Fields |
| --- | --- | --- |
| Calendar date | `YYYY-MM-DD` | `bidDate`, `followUpDate`, `dateOfBirth`, commitment dates |
| Month | `YYYY-MM` | Work history and education dates |
| Naive datetime | `YYYY-MM-DDTHH:mm:ss` — **no offset** | `InterviewRound.dateTime` |
| Instant | Full ISO-8601 with `Z` | `createdAt`, `updatedAt` |

**Work history and education are months, not dates.** A Resume prints "Aug 2024"; a day was
precision the data never had, and asking for one invited a wrong answer to a question nobody
reads. They are stored as `TEXT` rather than a truncated `DATE`, so the column says what it
holds — `YYYY-MM` still sorts correctly as a string, and nothing queries these by date.

A full `YYYY-MM-DD` is still *accepted* on input and truncated, so a data export taken before
the change still imports. Only `dateOfBirth` keeps a day.

Calendar dates and naive datetimes are stored in `DATE` / `TIMESTAMP` columns without a
timezone and moved through JS `Date` anchored to UTC, so the calendar fields the user typed are
the fields that come back. This matches the frontend, which builds interview times as `` `${date}T${time}:00` `` and
reads them with `parseISO` — local wall-clock, no conversion.

Because interview times carry no offset, "is this interview still upcoming?" needs the
client's timezone. `GET /api/dashboard` accepts `tzOffset` (the browser's
`getTimezoneOffset()`); omitting it evaluates "now" in UTC.

## 4. Technical direction

| Concern | Choice | Why |
| --- | --- | --- |
| Language / runtime | TypeScript 5.9 (strict) on Node.js 22 | The frontend is TS 5.9 strict; the domain types are a literal mirror across the boundary |
| Framework | Express 5 | Async handler rejections propagate to the error middleware natively, so no `asyncHandler` wrapper is needed |
| Database | PostgreSQL 14+ | Enums, a partial-unique constraint for rule 2, and `groupBy` aggregates for the dashboard |
| ORM / migrations | Prisma 7 (with the `pg` driver adapter) | Typed queries and a real migration history |
| Validation | Zod 4 | Same major version as the frontend; also the source of the OpenAPI spec |
| Auth | JWT in httpOnly cookies | Argon2id passwords, short-lived access tokens, rotating refresh tokens (§6.1) |
| Docs | OpenAPI 3.1 + Swagger UI | Generated from the Zod schemas, so it cannot drift from what the API accepts |
| HTML parsing | cheerio + turndown | Reading a job posting (§6.3) needs a DOM to query and a converter to Markdown; neither pulls in a browser engine |
| Tests | Vitest + Supertest | Integration tests over real HTTP against a real Postgres |
| Logging | Pino | JSON in production, pretty in development; cookies and passwords redacted |

Two constraints from the frontend shaped this:

- **The client's data access is one module.** `src/lib/storage.ts` is a CRUD module wrapped by
  TanStack Query hooks in `src/hooks/use-data.ts`. The API is shaped to fit the existing query
  keys (`['bids']`, `['profile']`, `['settings']`) so swapping it for an HTTP client is a
  change to that one file.
- **Response shapes are the frontend's shapes, verbatim.** Optional fields are *omitted*, not
  `null`, because the frontend's types declare them `field?: T`. See
  [`src/bids/bids.mapper.ts`](src/bids/bids.mapper.ts).

## 5. Getting started

### 5.1 Prerequisites

- Node.js **22+**
- Yarn 4 (via Corepack: `corepack enable`)
- PostgreSQL **14+** — either your own instance, or the container in §5.2

### 5.2 A local database

If you already run Postgres locally, skip to §5.3 and point `DATABASE_URL` at it.

Otherwise, a throwaway container is the quickest path. This is a **local development
convenience only** — nothing in the repo depends on it:

```bash
docker run -d --name global-eyes-pg \
  -e POSTGRES_USER=globaleyes \
  -e POSTGRES_PASSWORD=globaleyes \
  -e POSTGRES_DB=global_eyes \
  -p 55432:5432 \
  postgres:17-alpine

# The test suite truncates every table between cases, so it gets its own database.
docker exec global-eyes-pg \
  psql -U globaleyes -d global_eyes -c 'CREATE DATABASE global_eyes_test'
```

Useful afterwards:

```bash
docker stop global-eyes-pg          # pause it
docker start global-eyes-pg         # resume, data intact
docker rm -f global-eyes-pg         # delete it and everything in it
```

### 5.3 Configure and run

```bash
yarn install
cp .env.example .env

# Two different secrets, 32+ chars each:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

yarn prisma:generate     # generate the typed client into src/generated/
yarn prisma:migrate      # create the schema
yarn db:seed             # optional: a demo account with 46 bids
yarn dev                 # http://localhost:4000, docs at /docs
```

`yarn db:seed` creates two accounts, both **admins** — seeding is the one place a hand is
already in the database, and roles are promoted by hand (§6.5):

- `demo@remoteops.test` / `demo-password-1234`, with data mirroring what the frontend used to
  generate into `localStorage`: 46 bids, an active contract and the "Jordan Rivera" profile.
- `techzen1297@gmail.com` / `QWE!@#qwe123`, with no bids and an empty profile — an account to
  sign in as, not a populated example.

Both are upserted, so re-seeding resets their passwords and re-asserts their roles rather than
failing on the unique email. Note that re-seeding **replaces the demo account's bids**. It
refuses to run with `NODE_ENV=production`. Put those two values in the frontend's `VITE_DEMO_EMAIL` /
`VITE_DEMO_PASSWORD` and its sign-in page offers them as a one-click fill.

Resume generation (§6.4) needs an AI key on top of that — `OPENAI_API_KEY` by default — and
candidate photos (§6.5) need an S3-compatible bucket. Both are optional to configure and fail
the same way: leave them unset and everything else runs, with `POST /api/resume/generate` and
`POST /api/profile/photo` alone answering `503`, each naming the variables it wanted. Reading a
job posting from its URL (§6.3) works with nothing set; `JOB_READER_API_KEY` makes its fallback
through the reader service reliable from a cloud network, which otherwise may be refused.

### 5.4 Commands

| Command | Does |
| --- | --- |
| `yarn dev` | Watch-mode server on `PORT` (default 4000) |
| `yarn build` | Generate the Prisma client, then compile to `dist/` |
| `yarn start` | Run the compiled build |
| `yarn typecheck` | Type-check `src`, `tests` and config, emitting nothing |
| `yarn test` | Run the integration suite |
| `yarn test:watch` | Same, in watch mode |
| `yarn prisma:migrate` | Create and apply a migration (development) |
| `yarn prisma:deploy` | Apply pending migrations (production) |
| `yarn prisma:studio` | Browse the database in a GUI |
| `yarn db:seed` | Seed the demo account (development only) |
| `yarn admin <email> [pw]` | Create or promote one administrator, on any database |

### 5.5 Tests

```bash
createdb global_eyes_test     # or the docker exec line in §5.2
yarn test
```

The suite runs against a **real Postgres**, not a mock — the things most likely to break here
are the `UNIQUE (bid_id, stage)` constraint, `DATE` columns round-tripping without a timezone
shift, and transaction rollback, none of which a mocked client would catch. Every table is
truncated before each test, so `TEST_DATABASE_URL` must never point at real data;
[`src/env.ts`](src/env.ts) refuses to start the suite unless `NODE_ENV=test`.

The one exception is the job-URL parser (§6.3), where `fetch` is stubbed:
[`tests/jobs.test.ts`](tests/jobs.test.ts) asserts what we do with a page rather than that the
internet is up. The address check underneath it is exercised for real, because it is the whole
of the SSRF defence.

## 6. The API

Base URL `/api`. Full interactive reference at **`/docs`**; the raw document is at
`/openapi.json`. Every error shares one envelope:

```json
{ "error": { "code": "UNPROCESSABLE_ENTITY", "message": "...", "details": [ ... ] } }
```

so the client branches on `code` rather than string-matching prose.

### 6.1 Auth

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account, plus its profile and default settings |
| `POST` | `/api/auth/login` | Start a session |
| `POST` | `/api/auth/refresh` | Rotate the refresh token, issue a new access token |
| `POST` | `/api/auth/logout` | Revoke the refresh token and clear cookies |
| `GET` | `/api/auth/me` | The current account |

Registration takes `email`, `password`, `firstName`, `lastName` and an optional
`dateOfBirth` (`YYYY-MM-DD` or `''`). The last three open the Resume profile, so the Settings
screen does not ask the same questions again. There is deliberately no `confirmPassword`: it
exists to catch a typo while the cursor is still in the box, and by the time a request is on
the wire there is only ever one password. Every account is created with role `user`.

The account object returned by all five routes carries `id`, `email`, `role` and `createdAt`.

Passwords are hashed with **Argon2id** (19 MiB, t=2, p=1 — the OWASP second configuration).
Both tokens travel as **httpOnly cookies**, so no script on the page can read them:

- `ge_access` — a JWT, 15 minutes by default, sent on every request.
- `ge_refresh` — an opaque random string scoped to `path=/api/auth`, so it never rides along
  on ordinary API traffic. Only its SHA-256 digest is stored, so a database leak does not hand
  over usable tokens.

Refresh tokens **rotate**: each use revokes the presented token and issues a new one.
Presenting an already-rotated token is treated as evidence of theft, and every token in that
user's family is revoked. `GET /api/auth/me` also accepts `Authorization: Bearer <token>`, so
`curl` and the Swagger "Try it out" button work without a cookie jar.

Login returns the same `401` message for a wrong password and an unknown account, and hashes a
placeholder when the account does not exist so response time does not reveal which emails are
registered.

### 6.2 Bids

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/bids` | List. Optional `search`, `company`, `status`, `from`, `to`, `sort`; add `page`/`pageSize` for one page of it |
| `GET` | `/api/bids/pipeline` | The Pipeline board's opening state: every stage's count and first `pageSize` cards |
| `POST` | `/api/bids` | Create |
| `GET` | `/api/bids/:id` | Fetch one |
| `PATCH` | `/api/bids/:id` | Partial update |
| `DELETE` | `/api/bids/:id` | Delete |
| `POST` | `/api/bids/bulk/status` | Move many bids to one status |
| `POST` | `/api/bids/bulk/delete` | Delete many bids |
| `GET` | `/api/bids/:id/resume?format=pdf\|docx` | Download the Resume stored against one application |
| `GET` | `/api/bids/:id/cover-letter?format=pdf\|docx` | Download the cover letter stored against it |
| `GET` | `/api/bids/:id/chat` | The conversation held while filling in this application (§6.4) |
| `POST` | `/api/bids/:id/proof` | Upload the screenshot of the job site's confirmation page (multipart, field `proof`); 409 when it duplicates another of the profile's |
| `POST` | `/api/bids/proof/check` | Is this screenshot already on one of the profile's applications? Nothing stored (multipart, field `proof`) |
| `GET` | `/api/bids/:id/proof/matches` | The same profile's other applications whose screenshot is the same picture |
| `DELETE` | `/api/bids/:id/proof` | Remove it (admin only) |

Ownership is part of every lookup, so another user's bid is a **`404`, not a `403`** — a `403`
would confirm the row exists.

**Paging.** `GET /api/bids` answers two ways. With neither `page` nor `pageSize` it returns the
whole list as an array, which is what the Dashboard, the Calendar and the Commitments page
still read — each derives its view from every application. Naming either switches the answer
to a page:

```json
{ "items": [...], "page": 2, "pageSize": 25, "total": 312, "totalPages": 13 }
```

`pageSize` is 1–100 and defaults to 25; `page` is 1-based, and a page past the end is an empty
page rather than an error, because a table lands there when the last row on its page is
deleted. `total` counts across the same filters, so "showing 26–50 of 312" is true even though
25 rows were sent. The count and the page are read in one transaction so they describe the
same moment. `sort` is `bidDate` (the default), `updatedAt` (the board's) or `number` (the
table's). The first two are newest first and `number` is filing order, #1 first; all three
end on the row id, so two applications imported in the same
millisecond come back in the same order on every request — without that, a row could appear
on two pages and another on none.

**The board.** `GET /api/bids/pipeline?pageSize=10` is the Pipeline board's opening state in
one request: every status in funnel order, empty ones included, each with its `total` and its
first `pageSize` cards ordered by `updatedAt` — so a card just moved leads its column. One
`groupBy` answers all eleven counts. A column's later pages come from
`GET /api/bids?status=…&sort=updatedAt&page=2&pageSize=10`, which is the same query with an
offset, so page 2 lines up exactly behind what the board opened with. The board used to be
built client-side from the whole list, which meant a stage holding four hundred failed
applications was four hundred cards laid out to show the twenty that fit on screen.

**Proof of application.** A job site sends the candidate to a "thank you for applying" page
once the application is in, and a screenshot of that page is what an admin checks a candidate
against — that the jobs in their list were really applied to. `POST /api/bids/:id/proof` stores
it: multipart, one file in the `proof` field, JPEG, PNG, WebP or GIF, at most 5 MB, into the
same private bucket as the candidate photos (§6.5) under `proofs/<bidId>/…`. Every bid then
carries a short-lived signed `proofUrl`, so the table can show the link on every row; a bid
without one simply has no `proofUrl`, which is what an admin looks for. Anyone who can write the
bid can replace its screenshot — the old object is deleted once the new key is written — but
only an admin can remove one, because the screenshot is not the candidate's to take back.
Deleting a bid, singly or in bulk, deletes its screenshot best-effort after the row.

**The same screenshot twice.** One person filing the same confirmation page under two
applications is what the screenshot exists to catch, so every upload is compared with the same
profile's other screenshots — the profile the bid belongs to: the candidate's own on their
upload, the chosen candidate's on an admin's. Other profiles' screenshots are not compared. The
comparison is of the *picture*, never the file: a screenshot uploaded twice is rarely the same
bytes twice (saved again, renamed, stripped of its EXIF, re-wrapped as a PNG, padded with
white), and file names, sizes and checksums all change while the page does not.

It is a **match, not a similarity score**, and that is the point. Two confirmation pages from
one board — "Thank you for applying" for two different jobs — are one template with a line of
text and a brand colour changed. Measured on confirmation pages rendered in a browser, the
closest such pair differs by 0.059 on the scale below, while the *same* page saved again as a
GIF differs by 0.035 and at half size by 0.080: the difference between two applications is
smaller than the damage an encoder does. A band wide enough to hold every copy of one page is
therefore wide enough to swallow a different application's page, and both scores tried before
this — a gradient hash, then a correlation of thumbnails — did exactly that, refusing
screenshots a candidate had just taken. A screenshot wrongly refused is work blocked; a
duplicate not spotted is a warning not shown.

So `src/proof/fingerprint.ts` decodes the upload with sharp, draws it on white, and stores two
things on the bid (`proofFingerprint`, about 4 KB):

- a **SHA-256 of the picture's own pixels**, with the white margin trimmed off. Two uploads of
  one screenshot agree here whatever file they arrive in — re-saved as PNG, as lossless WebP,
  padded with white, cropped into the margin, with a strip of browser chrome cut off, renamed,
  stripped of EXIF. Equality of a hash cannot be a false positive: different pictures do not
  collide.
- a **32×32 grid of mean colour**, taken inside the *content frame*: the part of the picture
  holding all but a fifth of a percent of its ink, found on a small blurred copy and then
  measured again inside itself, which is what makes it land in the same place on a picture and
  on a JPEG of it. (Sharp's own trim does not: a LinkedIn confirmation and a JPEG of it trim to
  boxes 40 pixels apart, and nothing downstream lines up.) Grids are compared cell by cell and
  the *worst* cell decides, after lining them up — every offset from a cell out to a cell back,
  in half cells, values between cells interpolated — because a fraction of a cell of slide
  across the foot of a header bar moves a cell as far as an encoder does. The same picture, when
  the worst cell is within 0.045 and the two frames are the same shape.

Calibrated on 36 rendered confirmation pages — Greenhouse-, LinkedIn- and Workday-style, six
employers and six roles. All 36 are recognised through every lossy re-encoding (JPEG at 95, 75
and 40, WebP at 50, GIF), the worst at 0.035, and through every lossless change by hash alone.
None of the 630 pairs of *different* pages is matched, the closest at 0.059. A copy at another
size, or padded *and* re-encoded, is recognised perhaps half the time — the price of a band this
narrow, and the right way round. (The first version hashed gradients on a 9×8 grid, the second
correlated 32×32 thumbnails; both took different mostly-white pages for one another. Their
fingerprints are versions 1 and 2, are never compared, and are only re-fingerprinted by the
backfill.) A file sharp cannot decode is refused with 400 before the bucket is touched.

**A duplicate is refused, not stored.** Every application has its own confirmation page or
none: `POST /api/bids/:id/proof` compares before it writes and answers 409 `DUPLICATE_PROOF`
when the picture is already on another of the profile's applications, with the matches in
`error.data.matches` so the form can name and open them. The same comparison is available
without an upload as `POST /api/bids/proof/check` — the form's, the moment a screenshot is
picked, pasted or dropped and before there is an application to store it on: the same multipart
shape, nothing stored, and — as fields beside the file — `bidId` for the application being
edited (left out of the comparison, its own screenshot being no duplicate of itself) or
`userId` for the candidate an admin is filing for (ignored for a plain account).
`GET /api/bids/:id/proof/matches` finds, from the stored fingerprints, the pairs the rule could
not prevent — screenshots uploaded before fingerprints existed and since backfilled — for the
details view, where an admin can see them and have one replaced. Each match carries the other
application and how it was recognised: `identical` when the pixels are the same, otherwise the
`difference` between the grids. Screenshots uploaded before fingerprints existed have none, and
ones fingerprinted by an earlier version of the method are not compared, until
`yarn proofs:fingerprint` (`scripts/fingerprint-proofs.ts`) has read each one back from the
bucket once; it is idempotent, touches only what has no current fingerprint, and skips what it
cannot decode.

Its own route rather than a field on `POST /api/bids`, for the reason the photo has one: the
bid is JSON the form edits and re-saves, the screenshot is a file picked once. The form makes
it mandatory for every role — an application will not save without one, an admin's included —
and uploads it straight after the save. The API itself does not refuse a bid without one:
`POST /api/data/import` restores bids from a backup that carries no files, so a bid with no
`proofUrl` has to remain representable, and its absence is what an admin looks for.

**Already applied here?** `GET /api/bids?company=Google` is the application form's duplicate
check. After a posting is read from its URL, the form asks for every application in scope at
the parsed company — the caller's own for a plain account, every profile's for an admin — and
shows them in a modal before anyone applies to the same company twice for the same profile.
`company` matches the whole name, case-insensitively: `search` already does substrings, and a
substring would report an application at Metabase as one at Meta.

On `PATCH`, supplying `interviews` replaces the whole set; `commitmentDetails: null` clears the
commitment while omitting the key leaves it untouched. `applicationChat` follows the same
rule, as do `resumeDocument` and `coverLetterDocument`, and it matters most for the
transcript: an empty list clears it, and *omitting* the key leaves it alone — the edit form submits the whole bid back, and a screen that never opened the
drawer must not be able to wipe it by saying nothing. Unknown keys are stripped rather than
rejected, because the frontend's edit form submits the entire bid back — `id`, `createdAt` and
`updatedAt` included — and those are server-owned.

### 6.3 Job postings

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/api/jobs/parse` | Read the posting at a public URL and return it as Markdown |

```http
POST /api/jobs/parse
{ "url": "https://job-boards.greenhouse.io/acme/jobs/123" }

200 OK
{
  "url": "https://job-boards.greenhouse.io/acme/jobs/123",
  "description": "## About the role\n\nWe are hiring a **senior** engineer…",
  "truncated": false,
  "strategy": "container",
  "title": "Senior Frontend Engineer",
  "company": "Acme Corp",
  "location": "Remote, Austin, TX",
  "employmentType": "Full Time",
  "datePosted": "2026-03-01"
}
```

**Nothing is stored.** The response is a draft handed back to the application form; it becomes
a bid only if the user saves one. Extraction is a guess, and the user is the one who can tell
whether the guess is right.

**How the posting is found**, best source first — `strategy` in the response says which one won:

0. `board` — **a board's own API**, for the boards whose page is an empty shell until
   JavaScript runs but which hand the same posting out through an unauthenticated JSON call
   the page itself makes. Currently:
   - **ADP WorkforceNow**
     (`workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=…&ccId=…&jobId=…`,
     read from `…/careercenter/public/events/staffing/v1/job-requisitions/{jobId}`). Yields
     the title, location and posting date. ADP never names the employer, so the company comes
     from the description (see *Title and company* below).
   - **Gem** (`jobs.gem.com/{board}/{postId}`, read by POSTing the page's own
     `ExternalJobPosting` query to `jobs.gem.com/api/public/graphql`, which answers
     anonymously). The posting is three HTML fields — a board-wide intro and outro around the
     role's description, plus compensation when set — joined in that order. Yields the title,
     locations (prefixed `Remote` when the job says so), employment type and first-published
     date. The employer is not in the API, so it comes from the board slug and the intro.
   - **BambooHR** (`{company}.bamboohr.com/careers/{id}`, or the older
     `…/jobs/view.php?id={id}`, read from `…/careers/{id}/detail`, which answers anonymously).
     Yields the title, description (with compensation appended when set), location (prefixed
     `Remote` or `Hybrid` from the opening's location type), employment status and posting
     date. The employer is only in the subdomain, which the slug lookup below already reads.

   The board path yields the posting's own HTML — no cookie dialog, share row or footer. If
   the API fails or answers without a posting, the general path below gets its turn.
1. `json-ld` — a schema.org **`JobPosting`** block. Most boards publish one, because it is what
   puts them in Google's job search, and it is the only source that *names* the description
   rather than leaving us to guess at it. It also carries the title, company, location,
   employment type and posting date. A description that arrives entity-escaped
   (`&lt;p&gt;We are…&lt;/p&gt;` — JOIN encodes its HTML once more than it means to, and some
   boards twice) is decoded before it is read, so it becomes headings and lists rather than
   tags spelled out in the editor; a description that merely mentions `<section>` in a code
   span keeps it.
2. `page-data` — **the posting in the page's own data.** A company site built on Next.js (or
   anything else that ships its data as JSON in the page — `__NEXT_DATA__`, or any
   `<script type="application/json">`) renders the posting in the browser from an object the
   server already put in the page, typically the Greenhouse job it fetched: `title`, `content`
   and `location.name`. The rendered DOM says "Loading…"; the JSON says everything, so the data
   is walked breadth-first for the shallowest object with a short title (`title`, or `name` —
   Rippling's job object calls it that) beside a body long enough to be a posting (`content`,
   `description`, `descriptionHtml`, `jobDescription`, …), decoded if it arrived escaped, with
   its links resolved. A body that is an *object* of sections rather than one string is joined
   in the order it is written: Rippling splits its description into `{ company, role }`, two
   pieces of HTML the page prints one after the other. Yields the posting's own title, and the
   location, employment type, posting date and employer when the object names them (Greenhouse's
   does not name the employer — see *Title and company* below).

   **What is skipped, and why.** A page's data holds more than its posting, and two things in
   it wear the posting's shape. A **translation store** — `_nextI18Next`, `i18n`,
   `initialI18nStore`, `messages`, `locales` — holds the UI's own strings under exactly a short
   `title` beside a long `description`, so those branches are not walked at all: a Rippling page
   carries a consent notice headed `{{companyName}} uses AI to analyze applications`, and that
   is the role the parser used to come back with. And any title still holding a template's
   **placeholder** — `{{companyName}}`, `${role}`, `%{count}` — was written to be filled in and
   never was, which makes it a UI string rather than anything a posting says.
3. `container` — a known container: Indeed's `#jobDescriptionText`, LinkedIn's
   `.jobs-description__content`, Greenhouse's `.job__description`, Paylocity's
   `.job-preview-details`, Workday's `[data-automation-id="jobPostingDescription"]`, and a set
   of generic `*job-description*` attribute matches for everything else. Cookie-consent
   overlays (OneTrust, Cookiebot and the usual `*cookie-banner*` names) are removed first,
   along with scripts, forms and navigation — and with anything written as a *link* that is
   really a button (`a[role="button"]`, `*apply-btn*`, `*apply-button*`), because a board is
   free to put its "Apply" inside the very block that holds the description, where nothing
   else would catch it.
4. `readability` — the densest block of text on the page, scored as *characters minus three
   times the characters inside links*. Navigation and "related jobs" rails are nearly all
   anchor text, so they lose to a paragraph of prose.
5. `page` — the whole `<body>`, when no single block is long enough but the page as a whole is:
   a posting written as bare paragraphs with nothing wrapping it. Better the page with its
   furniture than nothing; the user is about to edit it anyway.
6. `reader` — **the fallback.** When the direct read produces nothing — the site refused, timed
   out, sent a PDF, or sent a page with no posting in it — the same URL is sent to the reader
   service at `JOB_READER_URL` (default: Jina's public reader, `https://r.jina.ai/`), which
   loads it in a real browser and answers with the page as Markdown. This is what makes
   LinkedIn, Indeed and the JavaScript-only boards (Workday and its kind) readable: a plain
   `fetch` gets a `403` or an empty shell from them, and a headless browser does not. Reader
   answers under 200 characters — a sign-in wall, a "loading" shell — are discarded. The
   page's URL is the only thing sent. `JOB_READER_API_KEY` is sent as a bearer token when set;
   Jina serves anonymous calls from a quiet network but refuses them from a busy one, so a
   deployment wants a key (free). Set `JOB_READER_URL` empty to disable the fallback.

   **Asked twice, when the first answer is a shell.** A reader loads the page in a browser but
   still has to decide when it is finished, and for a single-page app its answer can be "now"
   while the app is still fetching: Paycom's portal
   (`paycomonline.net/v4/ats/web.php/portal/…/jobs/…`) comes back as the word "Loading…" and a
   line asking for JavaScript. A reply that short is a shell, and rather than discard it the
   parser asks once more with `x-wait-for-selector: h1` and `x-timeout: 20` — wait for the
   posting's own heading, which a rendered page has and a shell does not. Paycom then answers
   with the posting, in about three seconds. Only a *short* answer is retried: a refusal, a
   timeout or an unreadable body would fail the same way twice. And when the heading never
   appears the reader waits out its timeout and answers with whatever the page did have, so the
   retry cannot turn a page that reads today into one that does not — the worst it costs is the
   wait.

   A rendered page read as text is the posting *plus* everything a browser shows around it,
   so the reader's Markdown is swept before it is returned (`stripPageFurniture` in
   `markdown.ts`): linked logos, share rows ("Facebook LinkedIn Email X Copy URL"), "Apply" and
   "Back" buttons, "Powered by", the copyright line, footer link rows, accessibility and
   browser-support notices, and the cookie dialog with its checkbox list. Paragraphs like those
   are dropped wherever they occur, and the page is cut off at the first footer or
   cookie-dialog heading that appears after most of it has gone by — a cookie notice that
   comes *before* the posting is dropped on its own rather than used as a cut point. Only
   short paragraphs (≤ 400 characters) are ever treated as furniture; prose stays whatever it
   opens with. A paragraph that is only a link is read as the word it shows, so
   `[Apply](https://…/Apply/4469897)` is the same furniture as `Apply`. The account strip a
   portal puts above the posting (`Careers`, `Sign In`, `Create Account`), the lone letter a
   closed modal leaves behind, a footer that opens with its links rather than its copyright
   (`Terms of Use | Privacy Policy | © 2026 Paycom | All Rights Reserved.`), and the
   apply-on-your-phone widget a page closes with (`Scan this QR code and apply!`) go the same
   way. Three more shapes come from portals rather than boards: a **list whose every item is a
   link** is a navigation rail rather than a posting's bullets; a **language picker**
   (`English (United States)`) is the language the page is being read in; and a **short
   paragraph the page has already printed once** is the footer repeating itself — a Dayforce
   portal lists a job's locations under the title and again at the foot, punctuated
   differently, and the posting said them the first time.

   **The same sweep runs on the direct read**, not only on the reader's Markdown. The noise
   sweep above removes what it can recognise as markup, but a container is chosen because it
   holds the posting, and what else it holds is the board's business: Paylocity puts an apply
   button at the top of it and another at the bottom, with "View All Jobs" after them. Prose
   is what survives either path.

**Title and company** are cleaned up after any of the reads (`metadata.ts`), because what a
page hands over is rarely the role and the employer, plain:

- A title from a structured source (JSON-LD, a board API) is kept whole, except that a company
  the source also named is stripped off the ends — `Senior Engineer at Acme`,
  `Senior Engineer - Acme Corp`, `Acme: Senior Engineer` become `Senior Engineer`. Legal
  suffixes are ignored in the comparison, so `Acme Corp Inc.` still strips `at Acme`.
- A page title is taken apart by the shapes the common boards use — and *both* `og:title`
  and `<title>` are read, because Greenhouse puts the role alone in the first and
  `Job Application for Role at Company` in the second:
  `Job Application for Role at Company` (Greenhouse), `Company - Role` (Lever),
  `Company hiring Role in City | LinkedIn`, `Role - City, ST - Indeed.com`,
  `Role @ Company` (Ashby), `Role | Location | Company`. Board names and site words
  (`Careers`, `Jobs`, `Recruitment`, `Career Center`) are peeled off either end first, and a
  title made only of those — a JavaScript shell's `Recruitment` — counts as no title. A hyphen
  alone never splits a title unless the other side plainly is a name, so `Controls SME - Design`
  stays a role; a bracket or a slash rules that side out, since `Auth0/AuthZ (Java)` is how a
  title qualifies a role, not how a company is written. `Rendered Inc Careers` yields the
  company and no role. A part shaped like a place (`Austin, TX`) is set aside as the location —
  unless it ends in a legal suffix, so `Coalition, Inc.` is the company and not a city.
- A company that comes only from *where a separator fell* (`Role - Company`, `Role | Company`,
  `Company - Role`) is a weak guess, not something the title says, so it is held back: a title
  that names the employer outright (`Role at Company`, `Company hiring Role`), the description
  and the board's URL all outrank it, and it is used only when none of them answers. Until then
  the whole title stays the role, and the name is taken back out of it once a company is
  settled on. That is what New Relic's Greenhouse page needs: `og:title` is
  `Software Engineer - Auth0/AuthZ (Java)`, which reads like `Role - Company` and is not, while
  `<title>` says `… at New Relic`.
- `og:site_name` is the employer on a company-run careers site and the board everywhere else,
  so it is used as the company only when it is not a known board — a board's name with a site
  word after it (`Rippling Recruiting`, `Greenhouse Job Board`, `Powered by Workable`) counts as
  the board. On a hosted board's URL (`ats.rippling.com/moov/…`) even a site name that is not
  recognised is more likely the board's than the employer's, so there it is consulted last,
  after the title, the description and the URL slug, rather than first.
- When nothing else names the employer, the description is read for it: an `About Applied
  Digital` heading (bold or not), `At Applied Digital, we…`, `Applied Digital is hiring…`,
  `Join Applied Digital as…`, or a paragraph opening `CentralReach is a leading provider
  of…`. Only a capitalised run of up to five words qualifies, so `About the role` and
  `Join our team` do not, and `Terraform is a plus` is not an introduction.
- Last, the URL: on a hosted board the employer's account is in it
  (`job-boards.greenhouse.io/centralreach/…`, `jobs.lever.co/acme/…`,
  `acme.wd5.myworkdayjobs.com`, `jobs.ashbyhq.com/temporal/…`, `jobs.gem.com/chiri/…`,
  `ats.rippling.com/moov/…`, `jobs.dayforcehcm.com/en-US/aline/…` — where the locale comes
  first and the employer second — Workable,
  SmartRecruiters, BambooHR, Recruitee, Teamtailor, Personio, iCIMS and a few more). The slug is looked up in
  the page's titles and text case-insensitively, with and without its hyphens, so
  `centralreach` becomes `CentralReach` as the page spells it; a slug the page never spells
  out is title-cased (`applied-digital` → `Applied Digital`).
- On the reader path, the reader's title is ranked *above* the shell page's `<title>`, since
  on a JavaScript shell that is the app's name, not the posting's; JSON-LD metadata found on
  the shell still outranks both. Failing all of those, the first heading of the posting is the
  title — on a job page the `<h1>` is the role.

Every one of these is a guess the user can overwrite in the form; the aim is only that the
guess be right more often than the raw string.

A URL that must not be fetched at all — not `http(s)`, or resolving to a private address — is
refused before either read, so nobody is asked to fetch it on our behalf. One development
exception: a machine behind a VPN or a filtering resolver that answers *every* name with a local
proxy address would refuse every job URL, and `JOB_FETCH_ALLOW_PRIVATE_ADDRESSES=true` lets the
fetch through there. It is ignored, with a warning in the log, under `NODE_ENV=production`.

The chosen HTML is converted to **Markdown** (`turndown`), which is both what the frontend's
description editor takes as input and the cheap way to discard what a job page wraps its prose
in — tracking attributes, layout divs, a class per element. Relative links are resolved against
the page URL first, images are dropped (from the reader's Markdown too), and the result is capped
at **20,000 characters** (`truncated: true` when it was cut) so that the HTML it becomes in the
editor stays under the 50,000-character limit on `jobDescription`.

**What it still cannot do.** A posting that even a browser only sees after signing in comes back
from the reader as the sign-in page, which is discarded; the error the user then sees is the
direct read's (`403`, most often), which says so, and the description is pasted by hand. There
is no attempt to log in anywhere.

**Failure modes**, all with the standard envelope:

| Status | When |
| --- | --- |
| `400` | `url` is missing or is not a URL |
| `422` | Not `http(s)`, resolves to a private address, or — after both reads — is not a web page or holds no description |
| `429` | More than 20 parses in a minute from one client |
| `502` | The site could not be reached, timed out, redirected too many times, or refused — and the reader could not read it either |

Because this is the one route that makes the server issue **outbound** requests, it is also the
one with an SSRF story — see §7.

### 6.4 Resume and cover letter generation, and the questions beside it

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/api/resume/generate` | Write the Resume's content for one application |
| `POST` | `/api/resume/render` | Lay that content out as a PDF or a Word file |
| `POST` | `/api/cover-letter/generate` | Write the cover letter, from the Resume and the posting |
| `POST` | `/api/cover-letter/render` | Lay the letter out as a PDF or a Word file |
| `POST` | `/api/resume/models` | List the models a platform will let a given key use |

```http
POST /api/resume/generate
{
  "company": "Acme Corp",
  "role": "Senior Backend Engineer",
  "jobDescription": "<h2>About the role</h2><p>We are hiring…</p>"
}

200 OK
X-Resume-Provider: openai
X-Resume-Model: gpt-5
{ "document": { "company": …, "role": …, "roleTitles": […], "summary": …, "skills": […], "bullets": [[…]] } }
```

**Those three fields are the whole input.** No profile, no bid history, and nothing else about
the account is sent to the AI platform. Everything the Resume says about the candidate — and
every rule about how one is written — comes from the system prompt.

**Generating and rendering are separate requests**, so that a second file costs nothing: the AI
is paid for once, and both a PDF and a Word copy come from the one answer. It also means a
regenerated layout never needs a regenerated document.

**The system prompt is server-side and stays there.** It lives in `src/resume/prompt.ts` as
Markdown — the numbered rules are structure the model reads, not decoration, and a flat block
of prose loses it. No route returns it, no response embeds it, and the client cannot override
it. An admin screen will eventually hold and edit it, at which point that constant becomes the
fallback rather than the only copy.

The prompt is what enforces the *shape of the writing*: a 3-sentence summary of 35 to 45 words,
6 skill buckets pipe-separated, bullet groups of 5 / 4 / 3 / 2 newest employer first, and the
character rules (no tilde, `%` not "percent", digits not words, hyphens not em-dashes). Those
counts are deliberately **not** in the JSON schema: OpenAI's strict mode does not implement
`minItems`/`maxItems`, and a schema only one of the three platforms accepts defeats the point of
having three. A near miss should cost a slightly wrong Resume, not a failed request.

**Three platforms, one seam.** `AI_PROVIDER` selects OpenAI, Anthropic or Google, and each has
an adapter under `src/resume/providers/`. All three are asked for the same schema through their
own structured-output mode — OpenAI's strict `json_schema`, Anthropic's `output_config.format`,
Gemini's `responseJsonSchema` — so the model cannot answer in a shape the renderer will not
take. The adapter is imported dynamically, so a deployment running on OpenAI never loads the
other two SDKs at all.

That schema is the reason every field of the payload is required and nothing is nullable:
OpenAI's strict mode rejects a schema whose properties are not all required. A section that does
not apply comes back empty and the renderer drops it.

#### The template

The Resume is laid out by the template from the **resume-builder desktop app**
(`desktop-version/`), which is where it was designed. Rather than reimplement it, both
renderers are ports of that app's own modules:

| Here | From | What it is |
| --- | --- | --- |
| `template/model.ts` | `src/resumeModel.js` | Content, with no styling — shared by both outputs so the two files cannot disagree |
| `template/html.ts` | `src/resumeTemplate.js` | The stylesheet |
| `template/docx.ts` | `src/resumeDocx.js` | The same measurements stated in Word's own terms |

Reusing the CSS, rather than re-deriving the same layout in a drawing library, is what makes
this the same document: every margin, size, font and space is the one that was already
specified. What has since been changed on this side, and not on the desktop app's, is what an
applicant tracking system reads — see *Written to be read by a machine first* below. The type
and the measurements are untouched.

**Which source owns what.** The split is by what varies:

| Profile | name, contact line, employers (company / location / dates), education (university / degree / major / dates) |
| --- | --- |
| **AI payload** | **summary, skills, role titles, bullets** |

The sections run **Summary, Skills, Work Experience, Education**, in both outputs — the order a
Resume conventionally uses, which is the order a parser is built to read — and their headings
are set in capitals.

Each entry is two lines with something against each margin:

```
Pipe                                                        Aug 2024 - Present
Senior Software Engineer                                 Franklin, TN (Remote)
• Cut p99 latency from 1.8s to 240ms across 40 million monthly transactions.

EDUCATION
Vanderbilt University - Nashville, TN                       Aug 2014 - Dec 2018
Bachelor of Science in Computer Science
```

The employer comes first and carries the dates; the role follows with the location. Education
reads the same way round — the institution first with its years, then what was studied there. In Word that is a **right tab stop** at the page's content width and a tab between
the halves; in the HTML it is two spans in a row (`display: flex`), left half first. Neither is
a table, because a parser reads a table cell by cell.

**The type**, which both renderers state in the same numbers:

| | |
| --- | --- |
| The name | 23pt |
| Section titles | **12pt**, set in capitals |
| Contact line, summary, skills | **10pt** — the document's default, which anything unstated inherits |
| A role | **11.5pt** |
| An employer, and the location and dates beside the two lines | **10.5pt** |
| Bullets | **10pt** |
| Education, all of it — the degree, the university, the years | **10pt** |

**The payload is Markdown**, and both renderers print its emphasis rather than its markers
(`template/inline.ts`, shared so they cannot disagree): `**bold**`, `*italic*`, `***both***`,
`` `code` `` as its text, `[text](url)` as its text — a URL being of no use on paper — and `\*`
as an asterisk. Inline only: a line arriving as `## Heading` or `- item` keeps those characters,
because a payload that could open a section could rearrange the document. A skills line is split
into its category and its skills *after* the Markdown is read, so `**Languages:** Go` and
`Languages: Go` print the same and neither leaves half a marker behind.

The profile is read from the signed-in account when rendering. It is never in the request — a
client cannot assert someone else's name or employers onto a page — and it is never sent to the
AI either. Bullet groups pair positionally with employers, newest first, which is the order the
prompt asks for them in.

Because the payload is the *whole* of what varies, **`/render` does not care where it came
from.** A document written by the AI and one pasted in by hand are the same request, which is
what lets the application form offer a manual mode without a line of new backend.

**Written to be read by a machine first.** A Resume is parsed by an applicant tracking system
before a person sees it, and a parser wants the plain end of the format. Everything the template
does is on that list, and it is worth naming what it deliberately does *not* do:

| | |
| --- | --- |
| One column, top to bottom | No side-by-side layout, no tables, no text boxes — a parser reads a table cell by cell and a two-column page in the wrong order |
| Real text | No images, no icons standing in for words, nothing that has to be OCR'd; the PDF is printed **tagged**, so the heading levels, the lists and the reading order travel with the glyphs |
| Headings a parser knows | `Summary`, `Skills`, `Work Experience`, `Education` — not "Core Skills", not "What I bring". A section a parser cannot name is a section whose contents it files nowhere. They are *set* in capitals rather than typed that way, so the text stays `Work Experience` |
| A line, not a table | The dates against the right margin are a right tab stop in Word and two spans in a row in the HTML, left half first. A table would be read cell by cell |
| Structure, not just weight | The name is an `h1` and the sections are `h2`s in the HTML; in Word they carry the real `Title` and `Heading 1` styles, redefined to this template's type so the document looks the same and says what it is |
| Dates it can read | `Mar 2022 - Present`, an ASCII hyphen between two `Mon YYYY`, the same way in both sections |
| A font it has | Calibri, embedded as metric-compatible Carlito — not a display face that has to be substituted |
| Nothing in the margins | No page header, no footer, no columns of contact details beside the name; the contact line is the second line of the body |

**The PDF is printed by headless Chromium**, which is a heavy dependency and is here for one
reason: the template is defined as HTML and CSS, and the desktop app prints it through
Electron. Printing the same stylesheet through the same engine matches by construction;
re-deriving it in a PDF library would mean matching every line height and page break by hand
and hoping. `preferCSSPageSize` hands the page size and the 0.5" Narrow margins to the
stylesheet's own `@page` rule.

Calibri is the specified font and exists on no server, so **Carlito — metric-compatible, same
advance widths — is embedded in the document as `@font-face`** under Calibri's name. That makes
the output deterministic: the desktop app's PDF depends on what is installed on the machine
that made it, and this one does not.

The bytes come from `template/font-data.ts`, a **generated** module holding the four faces as
base64, written by `scripts/generate-font-data.mjs` from the `@fontsource/carlito`
devDependency. They are code rather than files on disk because this runs in a traced serverless
bundle: the tracer ships what it can follow from the `import`s, and a runtime
`require.resolve` of a `.woff2` is not something it can follow — so the function deployed
without its fonts and every render threw `MODULE_NOT_FOUND`. Regenerate after bumping the
dependency; a test fails if the committed file has drifted from it.

**Deployment.** `@sparticuz/chromium` supplies the browser on Vercel, and `maxDuration` is 120s
to cover a slow generation. Set `PUPPETEER_EXECUTABLE_PATH` in development to reuse a browser
you already have. A function printing PDFs wants at least 1GB of memory; if printing fails on a
deployment while Word downloads keep working, that is the first thing to check — the `502` says
as much, because the two formats fail independently.

**Configuration.** `AI_PROVIDER` (default `openai`), one of `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, and an optional `AI_MODEL` overriding that provider's
default (`gpt-5`, `claude-opus-5`, `gemini-2.5-pro`). The key is **not** required at boot: a
deployment with none set serves every other route normally, and this one alone answers `503`
naming the variable it wanted. An admin screen will eventually own the provider and the key;
`resolveAiConfig()` is the seam it will read from, and the shape it returns is what an admin
record will have to supply.

| Status | When |
| --- | --- |
| `400` | A field is missing, or the description is over 50k characters |
| `429` | More than 10 Resumes in a minute from one client — every press costs money at a vendor |
| `502` | The platform failed, declined the request, or returned an unusable document |
| `503` | `AI_PROVIDER` has no API key configured |

#### The cover letter

The step after the Resume, and the same two-request shape: `POST /api/cover-letter/generate`
writes the letter, `POST /api/cover-letter/render` lays it out, and both formats come from the
one answer.

```http
POST /api/cover-letter/generate
{
  "company": "Acme Corp",
  "role": "Senior Backend Engineer",
  "jobDescription": "<h2>About the role</h2><p>We are hiring…</p>",
  "resume": { "company": …, "role": …, "roleTitles": […], "summary": …, "skills": […], "bullets": [[…]] }
}

200 OK
{ "document": { "company": …, "role": …, "greeting": …, "paragraphs": […], "closing": … } }
```

**The Resume is part of the input.** The prompt opens with "based on my resume", so the Resume
has to actually be in the request — and it travels in the body rather than being looked up,
because at this point the server usually does not have it: on the application form the bid has
not been saved yet, and on the JSON route the Resume was pasted in rather than generated here
at all. It is the document `/api/resume/generate` answered with, handed straight back.

**A second call rather than a second field on the Resume's answer.** Asking one call for both
would mean a letter that could not be rewritten without also rewriting the Resume it was
approved alongside, and it would put a page of prose inside a schema whose array counts are
already the hard part to get right. Two calls also means the letter is genuinely written *from*
the finished Resume rather than beside it.

**The file name is not the model's to decide.** The default prompt's first line names the file
with placeholders — `[First name] [Last name].docx` — because the actual name is built by
`resumeFileName` from the candidate's own profile, whichever candidate the letter is for. The
line stays because it tells the model what kind of document it is writing; a real person's name
there would be a rule about one candidate sitting in a deployment-wide setting. A prompt already
edited on the AI Settings screen keeps whatever it says: this constant is only the fallback.

**Its own system prompt**, stored in its own column and edited separately on the AI Settings
screen (§6.10). The two documents are held to different rules — a Resume is bullets against
word counts, a letter is four paragraphs against a structure — and one prompt serving both
would be edited for one and quietly change the other. It lives in
[`src/cover-letter/prompt.ts`](src/cover-letter/prompt.ts) as Markdown, and like the Resume's it
is returned by no route.

The prompt asks for four paragraphs in a fixed order — the Hook, the Core Value Proposition,
the Remote Proof and the Call to Action — inside 250 to 350 words, under the same character
rules the Resume follows (no tilde, `%` not "percent", digits not words, hyphens not em-dashes).
The schema takes `paragraphs` as an array rather than four named fields: the order is a rule
about what each paragraph *says*, and the template lays them out identically whichever is
which, so a letter that came back with three good paragraphs should render three good
paragraphs rather than fail.

**`**bold**` is the one piece of markup the paragraphs may carry.** The prompt asks for a
little of it and both renderers turn it into bold runs — `parseSpans` in
[`template/model.ts`](src/cover-letter/template/model.ts) is the only parser, so the PDF and the
Word file can never emphasise different words. It is deliberately *not* a Markdown renderer: an
underscore in a company name should stay an underscore, and a stray `**` should cost two
visible asterisks rather than a paragraph that is bold to its end.

**The page is the Resume's.** US Letter, Word's Narrow margins, Calibri bound to the embedded
Carlito — the two documents are sent together and read one after the other, so a letter set on
a different page would read as having come from somewhere else. What differs is the typography
inside it: 11pt rather than 10pt, looser leading, and a blank line between paragraphs instead of
the Resume's tight stack of headed sections.

**The letter is dated when it is rendered, not when it is written.** A fresh render uses today;
`GET /api/bids/{id}/cover-letter` uses the application's own `bidDate`, so a letter downloaded
months later still says when it was actually sent.

#### Where the Resume and the letter live

The generated document is stored on the bid, in a `resumeDocument` JSON column, and the
application form sends it with the save. The cover letter sits beside it in
`coverLetterDocument`, on identical terms. Storing the *content* rather than a file is what lets
one application be downloaded as either format later, and keeps the row small enough to sit on
the bid rather than in a blob store.

`GET /api/bids/:id/resume?format=pdf|docx` renders it. That costs nothing at the AI platform,
and it is always the Resume actually generated for that application — regenerating on each
download would hand out a different one every time, which is not what "download my Resume"
means.

The list endpoint carries a **`hasResume` boolean, never the document**: the list is what every
screen reads, whole or a page at a time, and a few kilobytes of Resume per row would make all
of them pay for a file almost none of them show. The document is read only for the row being downloaded.

A bid with none answers `404` on the Resume rather than on the bid — it exists, it simply
predates generation or was saved without one. A stored document that no longer parses against
the current shape answers the same way, with a message saying to generate it again, rather than
failing halfway through laying out a page.

The cover letter is the same story one column over: `GET /api/bids/:id/cover-letter` renders
what was stored, the list carries `hasCoverLetter` rather than the letter, and an application
without one answers `404` — writing a letter is an optional step, so most applications have
none.

Both columns follow the same write rule: `null` clears, and **omitting the key leaves it
untouched**. That second half is what lets an edit form that never generated a letter save
without wiping the one already there.

The rule that an application cannot be *created* without a Resume lives in the frontend form,
not here. Nothing requires a cover letter, anywhere.

#### What the file is called

```
Andrew Zhu.pdf
Andrew Zhu.docx
```

The candidate's name and nothing else — for the Resume and for the cover letter alike, in both
formats. It is the **same name every exit uses**: the two browser downloads, and the
`Content-Disposition` on `GET /api/bids/:id/resume` and `/cover-letter`, so a document carries
one name however it was obtained. [`src/resume/resume-file-name.ts`](src/resume/resume-file-name.ts)
is the rule; the frontend keeps a matching copy for the files it saves from a blob it already
holds.

**Why not the company and the role too.** They were in the name until they were not: the person
receiving the file already knows which opening they are filling, and what they cannot tell from
a folder of `Cover_Letter.docx` files is whose it is. The two documents of one application share
a name for the same reason — which of them it is, is plain from opening it, and a folder that
already holds one adds ` (2)` to the next rather than overwriting it (the browser does this, and
so does the Resume-folder writer).

Characters a filename cannot carry (`/`, `:`, `?`, `*`, quotes) become spaces and runs collapse,
and the name never ends in a dot or a space — a Resume lands on a real filesystem, and Windows
silently drops both. A dot *inside* the name stays, so `A.J. Cronin` keeps its initials. A
profile with no name yet — both halves are blank until someone fills the form in — falls back to
`resume.pdf` or `cover-letter.pdf` rather than to a file called `.pdf`, which a browser saves
happily and nobody finds again.

**The name follows the candidate, not whoever is downloading.** An admin's list spans profiles,
so a file named after the person pressing the button would be the wrong name on every row but
their own — which is also why the stored-Resume route renders from the *bid owner's* profile
rather than the caller's.

#### Listing a platform's models

`POST /api/resume/models` answers what the admin screen needs after a platform is chosen and a
key is typed in: which models that key can actually reach.

```http
POST /api/resume/models
{ "provider": "openai", "apiKey": "sk-…" }

200 OK
{
  "provider": "openai",
  "models": [{ "id": "gpt-5", "displayName": "gpt-5" }, …],
  "defaultModel": "gpt-5"
}
```

`apiKey` is **optional and never kept**. Supplied, it is used for that one call and discarded —
nothing stores it and nothing logs it, which is what lets a key be checked *before* it is saved
anywhere. Omitted, the key configured for that platform is used, so the route works today with
no admin screen in front of it.

Each platform needs different handling to answer the same question:

| Platform | How the list is narrowed |
| --- | --- |
| Anthropic | Not narrowed — every model it lists is a chat model, and each carries a display name |
| Google | Filtered on the `generateContent` capability each entry declares. An entry declaring nothing is kept: a missing field is not evidence a model cannot generate |
| OpenAI | Filtered by **excluding** the families that cannot write prose — embeddings, speech, images, moderation. Excluding rather than allow-listing means a chat model released tomorrow still appears; the cost is that a new *non-chat* family shows up until the pattern is extended, which is the cheaper mistake |

A key the platform rejects comes back as `400`, not `502`. In the flow this exists for, the key
is something a person just typed: "that key was rejected" is about their input, and a bad-gateway
error would name the wrong party as being at fault.

**It is not admin-only, because there is no admin role yet.** What an authenticated user can do
with it is list the catalogue of three fixed vendors, using either their own key or the
deployment's — no generation, so nothing is spent. Gate it on that role the moment one exists.

Choosing a model is still `AI_MODEL`. This route is the half of the picker that can be built
before there is a screen to put it on.

#### Timeouts

Generation is the one route that can legitimately take minutes, and it runs
inside a serverless function with a fixed budget. Three numbers have to agree,
in this order:

| | Where | Default |
| --- | --- | --- |
| The AI call's own timeout | `AI_REQUEST_TIMEOUT_MS` | 110s |
| The function's budget | `maxDuration` in [`vercel.json`](vercel.json) | 120s |
| SDK retries | pinned to **0** in each adapter | — |

**The ten-second gap is not slack**, it is everything either side of the AI
call: the cold start, the database round trips, and — on a download — printing
a PDF in a browser. Close it and the function dies while doing the work the
answer was fetched for.

**`maxDuration: 120` needs a plan that allows it.** Hobby caps a function at
60 seconds, and a deployment there will either refuse the configuration or cut
the invocation at its own ceiling; Pro allows up to 300. If the runtime keeps
killing invocations at 60 seconds after this change, the plan is the thing to
check first.

Retries being zero is the part that is easy to miss. The OpenAI and Anthropic
SDKs retry twice by default, so one slow generation could be attempted three
times inside a single budget — which guarantees the runtime kills the whole
invocation rather than any one attempt failing cleanly. That is what produces
`Vercel Runtime Timeout Error: Task timed out after 120 seconds`, an error with
no JSON body, no message the frontend can show, and nothing in the log about
which model was slow. It matters more on the chat route, where an SDK cannot
replay a reply the reader has already begun seeing.

With the call's own timeout *below* the function's, the same slow platform
produces a `504` naming the model and the budget, which is something an
administrator can act on.

**If generation still times out**, the model is the lever. `gpt-5`,
`claude-opus-5` and `gemini-2.5-pro` are the defaults and all three are
reasoning-heavy; a smaller model in the same family is usually several times
faster on a one-page Resume, and the AI Settings screen (§6.10) is where to
change it. Raising the ceiling instead means raising **both** numbers together —
`maxDuration` up to 300 on a Vercel plan that allows it, then
`AI_REQUEST_TIMEOUT_MS` to something under that, keeping a gap. Raising only the
second one changes nothing except which error you get.

Note that the *client* waits as long as the server does: nothing in the frontend
sets a deadline of its own, so a two-minute generation is two minutes of a
spinner. The chat route is the exception, and not by accident — a streamed reply
starts arriving in a second or two however long it runs on for, which is most of
why it streams.

#### The conversation beside an application

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/api/questions/chat` | Continue the conversation about one application, streaming the reply |
| `GET` | `/api/bids/:id/chat` | The transcript stored against one application |

A job application is rarely just a Resume upload. Beside it sit the boxes — "Why do you want to
work here?", "How many years with Kubernetes?", "What is your notice period?" — and answering
them is what used to send a user out of this app and into a chat window. This is that chat
window, with the application already in it.

```http
POST /api/questions/chat
{
  "company": "Acme Corp",
  "role": "Senior Backend Engineer",
  "jobDescription": "<h2>About the role</h2><p>We are hiring…</p>",
  "document": { "company": …, "role": …, "summary": …, … },
  "messages": [{ "role": "user", "content": "Why do you want to work here?" }]
}

200 OK
Content-Type: text/event-stream

event: delta
data: {"text":"Because "}

event: delta
data: {"text":"the payments work is exactly…"}

event: done
data: {}
```

**It streams, because the wait is the problem.** A paragraph that arrives all at once twenty
seconds later reads as a hung page; the same paragraph arriving a few words at a time reads as
an answer being written. Three frames: `delta` carries a fragment, `done` says the reply is
complete, `error` carries a message. `X-Accel-Buffering: no` is set because a proxy that
buffers the response until it is finished would deliver it all at once and undo the whole
point.

**Where a failure is reported depends on whether anything has been written yet**, and that
distinction is what `startChat` resolving *before* the headers are flushed buys:

| | Answered as | Because |
| --- | --- | --- |
| A blank message, no job description, no API key | JSON, with a real 4xx/5xx | Nothing has been written; the status line is still there |
| The platform dies mid-reply | An `error` frame, inside a `200` | The status line went out with the first fragment |

So a client must treat **a stream that ends without `done`** as a failure rather than as a short
answer. There is no other way to tell the two apart.

**Nothing is stored by this route, and there is no session.** The application and the whole
transcript travel on every turn — which is what lets the drawer work on an application that has
not been saved yet, and what lets the Resume change mid-conversation with nothing to
invalidate. The client owns the conversation; the server only ever answers the next turn.

**The application is folded into the first user message**, not sent as a turn of its own: a
conversation that opens with a wall of job description and no question invites the model to
reply to the description. The Resume travels with it when there is one, so answers can point at
the employers and numbers it actually claims rather than quietly contradicting it.

**The transcript, not the answers.** It is saved with the bid as `applicationChat` and read back
from `GET /api/bids/:id/chat`. An answer read a week later without the question above it is not
much use, and the follow-ups — "shorter", "less formal", "mention the fintech work instead" —
are usually where the good version came from. The bid list carries a `chatMessageCount` and
never the text, for the same reason it carries `hasResume` and never the document: the list is
what every screen reads.

**Every answer is two or three sentences**, whatever was asked. Even a question that looks like
it wants a number: "6 years." is a true answer to "how many years of Python?" and a wasted box
on an application form, because the employer left room for a paragraph and the applicant who
fills it with a fragment has told them nothing the Resume did not. The rule is stated as a
floor *and* a ceiling — a model given only a floor pads — and it holds for the follow-ups too,
where "shorter" means two tighter sentences rather than a fragment.

**The chat prompt is server-side and stays there**, in `src/questions/prompt.ts`. It is not
admin-editable the way the Resume's is (§6.10); `ai_settings.systemPrompt` is the pattern to
follow when it should be, and one editable prompt beside one built-in was a smaller thing to
explain than two half-editable ones.

#### Two ways to ask a platform something

An adapter offers two methods, because the two things this app asks for want opposite
treatment:

| | `generate` | `chat` |
| --- | --- | --- |
| Produces | one JSON document | prose, in fragments |
| Held to | a Zod schema | nothing |
| Worth reading | only when complete | as it arrives |
| Retries | none — see below | none, and it matters more |

**`generate` goes through [`src/ai/generate.ts`](src/ai/generate.ts)**, which resolves the
provider, model, key and timeout, holds the call to that timeout, turns three vendors' failures
into one set of messages, and checks the reply against the schema asked for. What differs per
feature is the schema and the two prompts, which are its arguments. It is also why `generate`
takes the schema with the request and answers `unknown`: two of the three SDKs validate against
a schema themselves and the third hands back a string, so validating in each adapter meant
three subtly different ideas of what "the wrong shape" is.

**`chat` cannot use that door**, because there is no schema to hold it to and the answer is
wanted before it exists. It resolves the config the same way and then hands back an async
iterable of text — the one shape all three SDKs already speak, which composes with `for await`
at every layer above and carries a failure as a thrown error rather than as an event nobody
remembered to listen for.

`maxRetries: 0` is set on both, and on a stream it matters more: an SDK cannot replay a
response the caller has already begun rendering, so a retry halfway through would restart the
answer from the top under the same reader.

### 6.5 Profile and settings

| Method | Path | Does |
| --- | --- | --- |
| `GET` / `PUT` | `/api/profile` | The Resume profile. `PUT` is a full replace |
| `POST` | `/api/profile/photo` | Upload the candidate photo (multipart, field `photo`) |
| `DELETE` | `/api/profile/photo` | Remove it |
| `GET` / `PUT` | `/api/settings` | Daily bid goal (admin-only to change) and theme |

Both are created at registration, so neither ever `404`s for a real account. Work history and
education are rewritten in the order given; client-generated UUIDs are honoured so the form's
React keys stay stable across a save, and non-UUID ids (the frontend's seed data used `"1"`)
get a server id instead.

Profile fields are deliberately lenient — the form is saved mid-edit, and a half-typed email
address must not block saving the rest of the Resume.

**The candidate photo** is its own pair of routes rather than a field on `PUT /api/profile`,
because the two are different requests: the form is JSON the user edits and re-saves, the
photo is multipart and is replaced by picking a file. Folding one into the other would mean
re-uploading the image on every unrelated save.

It goes to an S3-compatible bucket — Tigris, R2, MinIO or AWS, selected by
`AWS_ENDPOINT_URL_S3` (see `.env.example`). JPEG, PNG, WebP or GIF, at most 5 MB; anything
else is a `400` before a byte reaches the bucket. Leave the five variables unset and the
upload route answers `503` naming them, and every other route is unaffected.

What is stored on the profile is the **object key**, not a URL. The bucket stays private and
`GET /api/profile` signs a fresh `photoUrl` on every read (one hour by default,
`S3_SIGNED_URL_TTL_SECONDS`) — storing a signed link would mean handing out dead `src`s to
anything that cached a profile. Uploading a replacement writes a new key first and deletes the
old object afterwards, so a failed upload leaves the existing photo in place.

**`dailyBidGoal` is an administrator's setting**, unlike `theme`. A non-admin's
`PUT /api/settings` keeps whatever goal is stored, whatever it sends, and the stored value
comes back in the response. Rejecting the whole request instead would break the frontend's
theme toggle, which submits the entire settings object and has no business failing over a field
it never touched. `POST /api/data/import` follows the same rule, so restoring a backup is not a
way around it.

**Promoting an admin** is a deliberate act with no route behind it. `yarn db:seed` makes the
demo account an admin; otherwise do it by hand:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

`yarn db:seed` also creates a standing admin — `techzen1297@gmail.com` — with no bids and an
empty profile, so there is an account to sign in as on a fresh database without touching the
demo data.

**On a deployed database, use `yarn admin` instead.** The seed cannot help there: it refuses to
run with `NODE_ENV=production`, and rightly so — it *replaces* the demo account's bids, which
is correct for a development database and unacceptable anywhere real. Vercel's build runs
`prisma migrate deploy` and nothing else, so a deployed database has the schema and no seed data
at all. Since registration always creates a `user`, a fresh deployment has no way to produce its
first admin on its own.

```bash
# Create the account outright, or promote one that registered through the app.
DATABASE_URL='postgresql://…' yarn admin you@example.com 'a-long-password'

# Already registered? Leave the password out and only the role changes.
DATABASE_URL='postgresql://…' yarn admin you@example.com
```

The script touches exactly one row in `users` and the two singletons that hang off it. It never
deletes anything, never looks at another account, and is idempotent — promoting an account that
already exists keeps its bids, profile and settings. It reads `DIRECT_URL` in preference to
`DATABASE_URL`, and takes neither from `src/env.ts`, so creating an admin does not require the
JWT secrets and cookie settings that only a running server needs.

The role rides in the access token, so it takes effect on that account's next sign-in (or
within the 15-minute access-token lifetime, whichever comes first).

### 6.6 Dashboard

`GET /api/dashboard?days=7&weeks=12&limit=5&tzOffset=0` returns every aggregate the Dashboard
screen needs in one request: `totalApplications`, `statusBreakdown` (all eleven statuses,
zeroes included, because the pie chart's legend is fixed), `dailyGoal`, `todayCount`,
`dailyVolume`, `activity` (the heatmap, gaps filled with zero), `upcomingInterviews` and
`startedContracts`.

This replaces fetching every bid to the client and reducing over it — the README's original
complaint about "a full client fetch".

### 6.7 Data

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/data/export` | The whole account as JSON |
| `POST` | `/api/data/import?mode=merge\|replace` | Restore a backup |
| `DELETE` | `/api/data` | Delete all bids, reset profile and settings; the account survives |

### 6.8 Import closes the export gap

The export is byte-compatible with the `remote-ops-backup.json` the frontend already writes from
its Preferences page, and `POST /api/data/import` accepts exactly that shape — which is what
makes the frontend's existing backup restorable for the first time.

Imported bids become new rows owned by whoever is importing, so `id`, `createdAt` and
`updatedAt` in the file are ignored — as is `source`, which older backups still carry from
when the app tracked which board an application came from. The whole bundle is validated
against the business rules before anything is written, and the bids are inserted in one
transaction: a bad row near the end cannot leave a half-restored backup behind.

### 6.9 Managing accounts and profiles

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/admin/users` | Every account, with its profile summary and bid count |
| `POST` | `/api/admin/users` | Create an account, its profile and its settings |
| `GET` | `/api/admin/users/:id` | One account and its full profile |
| `PATCH` | `/api/admin/users/:id` | Change its email, password or role |
| `DELETE` | `/api/admin/users/:id` | Delete it and everything it owns |
| `PUT` | `/api/admin/users/:id/profile` | Replace its Resume profile |
| `POST` / `DELETE` | `/api/admin/users/:id/profile/photo` | Its candidate photo |
| `GET` / `PUT` | `/api/admin/users/:id/ai-prompts` | Its AI prompts — the per-profile half of AI settings (§6.10) |

Admin-only in full. The account and its profile stay one-to-one — this is a second way into
the same pair of rows, not a second model — and the profile routes go straight through
`profileService`, so an admin editing a profile and its owner editing it are the same write
with the same rules.

Two guards run through it. **An admin cannot delete their own account, and cannot change their
own role**: both are one click away from locking the last administrator out, and both are far
easier to prevent than to recover from. Changing a password also revokes that account's live
refresh tokens, because whoever knew the old one should not keep a session.

Deleting cascades to bids, interviews, commitments, profile, settings and sessions. It
deliberately does *not* chase the account's photo objects out of the bucket: a bucket delete
can fail, and half-deleting an account because S3 was briefly unreachable is worse than an
orphaned object.

### 6.10 AI settings

| Method | Path | Does |
| --- | --- | --- |
| `GET` / `PUT` | `/api/admin/ai` | Provider, model, the two default system prompts and the API key |
| `GET` / `PUT` | `/api/admin/users/:id/ai-prompts` | The same two prompts, for one profile (§6.9) |
| `POST` | `/api/resume/models` | The models the configured key can reach, for the picker |

Admin-only: the prompts are the product, and the key is a credential.
`POST /api/resume/models` is admin-only for the same reason, and lists against
the stored key when the caller supplies none — so the picker opens without
re-entering a key that is already saved.

**The environment is the fallback, not the alternative.** Each field falls back independently,
so an admin can override the model and leave the provider and key exactly as the deployment
configured them, and a fresh install with no row behaves precisely as it did before this
existed. `PUT` is a partial update: an omitted field is left alone, and an explicit `null`
clears that override and hands the field back to the environment.

**Two prompts, not one.** `systemPrompt` writes the Resume and `coverLetterPrompt` writes the
cover letter, in separate columns with separate defaults and separate resets. They are two
documents held to different rules, written by two separate calls, so clearing one back to its
built-in default must not touch the other. `overrides` reports each independently.

**Two AI settings, not one.** `/api/admin/ai` holds the deployment's *default* prompts;
`/api/admin/users/:id/ai-prompts` holds the same two prompts for one profile. Each prompt
resolves **profile → deployment → built-in default**, and each on its own: a profile may have
its own cover letter prompt and leave the Resume's to the deployment. `overrides` says which of
the two is set for the profile, `defaults` is the deployment's pair (what clearing reverts to),
and `null` or an empty string clears. The provider, model and key are not per profile — they
are infrastructure, not voice.

Both are admin-only. A candidate does not see their own prompts any more than they see the
deployment's: the prompt is the product, and there is no self-service route.

Generation reads the profile's prompt. `POST /api/resume/generate` and
`POST /api/cover-letter/generate` take an optional `userId` on the same terms as their `render`
routes: an admin generating for a candidate names them and gets that candidate's prompts, a
candidate generating for themselves gets whatever an admin set for them, and anyone else naming
another account is refused.

**The API key goes in and never comes out.** It is stored encrypted — AES-256-GCM, see
[`src/crypto/secret-box.ts`](src/crypto/secret-box.ts) — and `GET` reports only `hasApiKey` and
`keySource` (`database`, `environment` or `none`). The only reader that decrypts one hands it
straight to a provider adapter.

The encryption key comes from `CONFIG_ENCRYPTION_KEY`, or is derived from `JWT_ACCESS_SECRET`
when that is unset, so the feature works without a new variable. The cost of the fallback is
that **rotating `JWT_ACCESS_SECRET` makes a stored API key undecryptable** — the app logs a
warning, reports the key as absent and falls back to the environment, and the fix is to save
the key again. Set `CONFIG_ENCRYPTION_KEY` explicitly to decouple the two.

This is encryption at rest against a leaked dump or a careless backup. It is not protection
from someone who already has the application's environment; a deployment that needs that wants
a KMS.

## 7. Security notes

- **Ownership on every query.** No handler trusts an id from the client; `userId` is part of
  the `WHERE` clause, and cross-account access is covered by tests.
- **Cookies over `localStorage`.** httpOnly means XSS cannot read the session.
  `SameSite=Lax` is the default and is sufficient for the deployment the frontend is built
  for, where a rewrite puts this API on the app's own origin (§9.1). **`COOKIE_SAMESITE=none`
  makes a cross-origin deployment work, but it removes the CSRF defence and nothing replaces
  it** — no CSRF tokens are implemented. Prefer the same-origin setup.
- **`Secure` follows `NODE_ENV`.** Cookies are marked `Secure` in production only, so local
  HTTP development works. Deploy behind TLS.
- **Rate limiting** applies to the credential endpoints — the only routes where guessing pays —
  and to `POST /api/jobs/parse`, the only route that spends someone else's bandwidth.
- **SSRF is the risk `POST /api/jobs/parse` introduces**, because it makes this server an HTTP
  client on a URL the user typed: `http://169.254.169.254/` is a cloud metadata endpoint and
  `http://localhost:5432` is our own database. `src/jobs/fetch-page.ts` answers it with a
  deliberately boring fetch — `http(s)` only, no credentials in the URL, DNS resolved up front
  with **every** returned address required to be public (loopback, RFC 1918, link-local,
  carrier-grade NAT and the reserved ranges are all refused), redirects followed by hand so
  each hop clears the same check, HTML content types only, 2 MB and 12 s ceilings, and no
  response body or upstream header reflected back beyond a status code. What remains is DNS
  rebinding between the check and the connect, which would need pinning the resolved address
  through a custom dispatcher to close. The reader fallback (§6.3) is only ever given a URL
  that has already cleared that check — a private address is refused before anyone else is
  asked to fetch it — and the fetch to the reader itself goes to a fixed, configured prefix.
- **Candidate photos are private objects.** They are uploaded with `ACL: private` and read
  through short-lived presigned URLs rather than public links, so a bucket whose default ACL
  is public does not quietly make every photo world-readable. The signed URL is a bearer
  token for that one object until it expires — an hour by default — so treat a copied link
  accordingly.
- **Roles are now a real boundary.** An admin's scope over bids is deliberately empty, so they
  read and write every profile's applications; a plain account is still scoped to its own rows
  on every query. Changing a status, deleting an application, and everything under
  `/api/admin` are admin-only, enforced by `requireAdmin` on the route rather than by the UI
  hiding a button.
- **An admin API key is a secret in your database.** It is encrypted at rest and never
  returned, but anything that can read the application's environment can decrypt it — see
  §6.10 for exactly what that does and does not protect against.
- **Two distinct JWT secrets** are required; `src/env.ts` refuses to start if they match,
  which would let a refresh token be replayed as an access token.
- **Config is validated at import time**, so a missing secret stops the process with a
  readable message rather than surfacing as an undefined-shaped bug on first request.
- **Logs redact** cookies, `Authorization`, `Set-Cookie` and `req.body.password`.

- **Refresh tokens rotate on every use**, so the frontend single-flights its refresh call: six
  concurrent rotations would invalidate each other and end the session.

Not yet done, and worth doing before this is public: CSRF tokens if the deployment goes
cross-site, email verification, password reset, and account deletion.

## 8. Repository layout

```
.
├── prisma/
│   ├── schema.prisma        # the data model; enums map to the frontend's exact strings
│   ├── migrations/          # generated SQL, checked in
│   └── seed.ts              # demo account mirroring the frontend's old seed data
├── scripts/
│   └── create-admin.ts      # `yarn admin`: the one way to make an admin on a deployed database
├── api/
│   └── index.ts             # Vercel's entrypoint; exports the app from dist/
├── public/
│   └── index.html           # the deployment's static output: a landing page for /
├── src/
│   ├── index.ts             # bootstrap and graceful shutdown
│   ├── app.ts               # middleware, route mounting, /docs
│   ├── env.ts               # Zod-validated configuration
│   ├── prisma.ts            # client + pg driver adapter
│   ├── logger.ts
│   ├── domain/              # the wire contract, shared by every module
│   │   ├── types.ts         #   an exact mirror of the frontend's types.ts
│   │   ├── status.ts        #   the only bridge between DB enums and wire strings
│   │   └── dates.ts         #   the three date formats of §3.3
│   ├── http/                # error envelope, Zod validation middleware
│   ├── auth/                # argon2, tokens, cookies, the requireAuth guard
│   ├── bids/                # routes, schemas, service (business rules), mapper
│   ├── jobs/                # reading a posting from its URL
│   │   ├── fetch-page.ts    #   the SSRF-safe fetch: public http(s), capped, manual redirects
│   │   ├── extract.ts       #   JSON-LD, then known containers, densest text block, whole page
│   │   ├── reader.ts        #   the fallback: the same URL through a reader service (headless browser)
│   │   └── markdown.ts      #   HTML → Markdown, and the length cap
│   ├── ai/
│   │   └── generate.ts      #   one structured call: config, timeout, errors, schema check
│   ├── questions/           # the conversation about one application
│   │   ├── prompt.ts        #   the chat prompt — server-side, never returned
│   │   ├── questions.routes.ts   # the SSE stream: delta, done, error
│   │   └── questions.service.ts  # folds the application into the first message
│   ├── resume/              # writing a Resume with an AI platform
│   │   ├── prompt.ts        #   the system prompt — server-side, never returned
│   │   ├── resume-file-name.ts  # FirstName_LastName_Company_JobTitle[_Kind], every exit
│   │   ├── providers/       #   one adapter per platform: generate + listModels
│   │   └── template/        #   ported from the resume-builder desktop app
│   │       ├── model.ts     #     profile + payload → content, no styling
│   │       ├── html.ts      #     the stylesheet, carried over unchanged
│   │       ├── docx.ts      #     the same measurements, in Word's terms
│   │       ├── fonts.ts     #     Carlito embedded as Calibri, for determinism
│   │       ├── font-data.ts #       generated: the four faces, base64
│   │       └── pdf.ts       #     HTML → PDF via headless Chromium
│   ├── cover-letter/        # the step after the Resume, written from it
│   │   ├── prompt.ts        #   its own system prompt — server-side, never returned
│   │   └── template/        #   the Resume's page, a letter's typography
│   │       ├── model.ts     #     profile + payload → content; parses `**bold**`
│   │       ├── html.ts      #     the stylesheet; PDF via the Resume's printer
│   │       └── docx.ts      #     the same measurements, in Word's terms
│   ├── storage/
│   │   └── s3.client.ts     #   candidate photos: upload, presign, delete
│   ├── profile/             # the Resume profile and the candidate photo
│   ├── settings/
│   ├── dashboard/           # the aggregate queries
│   ├── data/                # export, import, reset
│   └── docs/openapi.ts      # the spec, generated from the Zod schemas
└── tests/                   # integration tests over real HTTP + real Postgres
```

Each feature module is the same four files: `*.routes.ts` (HTTP), `*.schemas.ts` (Zod, and the
source of the OpenAPI spec), `*.service.ts` (business rules and database access), and
sometimes `*.mapper.ts` (row → wire shape). Routes contain no logic and services contain no
HTTP, so a rule can be read in one place.

## 9. Connecting the frontend

**The frontend is wired to this API.** Its `localStorage` layer is gone; `src/lib/api.ts`
holds one function per route below and `src/hooks/use-data.ts` keeps the same query keys it
always had. What follows is what a deployment has to get right.

### 9.1 Put the API on the app's origin

The frontend calls **`/api` on its own origin** by default, and its Vite dev server proxies
that to `http://localhost:4000`. This is not incidental: the session cookies are
`SameSite=Lax`, and a browser will not send a Lax cookie on a cross-site request. Same-origin
is what makes them work at all.

In production the same shape applies — a platform rewrite from `/api/(.*)` on the app's
domain to this service. The frontend README §2.4 has the `vercel.json` for it.

Run it that way and CORS never enters the picture, because nothing is cross-origin.

### 9.2 If they really must be on different origins

Point the frontend's `VITE_API_URL` at this service and set **both**:

- `CORS_ORIGIN` — the app's exact origin. A wildcard will not work with `credentials: true`,
  which is what carries the cookies.
- `COOKIE_SAMESITE=none` — otherwise the browser silently drops the session cookie on every
  response and every login appears to succeed while leaving the user signed out.

`COOKIE_SAMESITE=none` requires `NODE_ENV=production`, because browsers reject a
`SameSite=None` cookie that is not also `Secure`; `src/env.ts` refuses to start otherwise
rather than let that ship. Note what this costs: SameSite was the CSRF defence, and nothing
has replaced it — see §7.

## 10. Deploying to Vercel

[`vercel.json`](vercel.json) drives the deployment. `yarn build` compiles to `dist/`, and
[`api/index.ts`](api/index.ts) exports the Express app from there as a single serverless
function that every path rewrites onto. Production deployments also run `prisma migrate
deploy` as part of the build. Set the same environment variables as `.env.example` in the
project settings; `DATABASE_URL` must point at a pooled connection.

`public/` is the build's static output: one landing page, listing `/docs`, `/openapi.json`
and `/health`. Vercel checks the filesystem before the rewrites, so that page answers `/` —
the only path the API itself does not serve — and everything else reaches the function.

Four details of the build are worth knowing, because each one has already broken a deploy:

- **`"framework": null` is deliberate.** Vercel has an `express` preset, and it detects this
  project as one on import. That preset deploys the app as a Node *server* and looks for a
  compiled entrypoint (`app.js`, `index.js`, `server.js`) inside the output directory, which
  fails here with `No entrypoint found in output directory: "public"` — this repo is the
  static-output-plus-`api/`-function shape instead. Selecting no framework restores that
  shape. If a deploy ever reports the entrypoint error again, check the project's Framework
  Preset in the dashboard as well.
- **The install runs through Corepack, on an explicit PATH.** `yarn.lock` is a Yarn 4
  lockfile, and Vercel's default `yarn` is 1.22, which cannot read it: it silently re-resolves
  every dependency and writes its own lockfile, so the deployed tree is not the tested one.
  `corepack enable` alone does not fix that — its shims land behind the build image's own
  `yarn` on `PATH`, and 1.22 still runs — so `installCommand` enables Corepack into
  `/tmp/corepack`, puts that first on `PATH`, and prints `yarn --version` before installing.
  Expect `4.17.0` in the log; `1.22.x` means the shim was bypassed again. Note the leading
  `mkdir -p`: `corepack enable --install-directory` fails on a directory that does not already
  exist. `package.json` names the exact Yarn version in `packageManager`, so keep `yarn.lock`
  committed and in sync with it, or `--immutable` will fail the build (which is the point).
- **`engines.node` is pinned to `22.x`.** An open range such as `>=22` opts the project into
  automatic major upgrades of the Node runtime, which Vercel warns about on every build.
- **Vercel type-checks `src/` with its own compiler settings**, not only with
  `tsconfig.build.json`. Its resolver can read a dependency's CommonJS declarations from a
  file this package treats as ESM, and a default import then types as the module object
  rather than as what the module exports — see the note above the `helmet` import in
  [`src/app.ts`](src/app.ts). A dependency whose `exports` map has no `"types"` condition is
  the one to watch for; `helmet` is currently the only direct dependency shaped that way.
