# Working in this repo

This is the software factory itself: a Bun CLI (`bin/factory.ts`) that serves a
Nuxt UI board and drives GitHub issues to merged PRs. README.md has the user's
view; this file is for whoever changes the code.

## Layout

- `server/factory/` — the engine, plain TypeScript with no Nuxt imports:
  `machine.ts` (stage transitions, each justified by files on disk),
  `store.ts` (job.json + per-step markdown; `appendEvent` adds a line to the
  job's `events.jsonl` and never throws; a move's unrepeatable steps — comments,
  labels, PR close, remote branch delete, the `intake.md` rename — are recorded
  in `job.json` `move` as each finishes, skipped on a retry of the same move,
  and cleared when the move is saved, and `Machine.answer` posts the operator's
  reply as one of these steps), `queue.ts`, `gate.ts`,
  `route.ts`, `merge.ts`, `orchestrator.ts` (its in-memory FIFO of issues
  queued by `runIssue` while every slot is busy, started by `fill()` ahead of
  the drain, sent as the `queued` event; `agent()` re-prompts an agent once,
  in the same session, when its report is missing or its first line invalid,
  while the builder's one second try stays in `build()`), `agents/` (prompts and the
  Claude Agent SDK runner), `gh.ts` / `git.ts` (adapters behind `ports.ts`),
  `setup.ts` (`init` / `doctor`), `service.ts` (what the server and CLI share),
  `attachments.ts` (image upload limits and `validateUpload`; no Node imports,
  the board imports it too).
  `events.jsonl` gets `stage` lines from `Machine` (advance, feedback,
  approve, reject, after job.json is saved) and agent, gate and merge lines from
  `orchestrator.ts`, which writes `agent-start` before an agent's watch is
  taken and `agent-end` after its check so its own lines are never undone.
  A driver failure is saved as `job.json` `error` (not for a shutdown abort),
  cleared by `start()` and by every stage move, and read back into
  `Orchestrator.errors` by `loadErrors()`, which `createFactory()` awaits.
  A cancel is not saved as an error: it puts the job in `Orchestrator.paused`
  (in memory, gone on restart), which the drain skips until `start()` clears
  it; `/api/state` sends `paused` and the `paused` event announces it.
- `server/api/` — Nitro routes over `useFactory()` (`server/utils/factory.ts`).
  Engine refusals throw `Refused`; routes wrap calls in `guarded()` → 409.
  The setup routes (`server/api/setup/`) use `projectDir()` instead of
  `useFactory()` so they work before `.factory/config.json` exists.
  `server/middleware/local-only.ts` applies `requestRefusal` (`service.ts`):
  foreign Host headers, API calls from another Origin or with
  `Sec-Fetch-Site` other than same-origin/none, and non-JSON writes are
  refused: keep every new write route a JSON POST, and keep GET routes
  read-only (the merged sweep runs in the orchestrator's tick, not in
  `/api/queue`; while paused, the board's `/api/merged` POST is the check
  for needs-human jobs merged by hand, on load and when a job panel opens).
  `server/api/jobs/[id]/[action].post.ts` takes feedback, reject, answer,
  merge (the board's Merge on an escalated job: `Orchestrator.approve`),
  retry (also the board's Resume) and cancel (pauses). `server/api/uploads.post.ts`
  takes images as base64 JSON and returns GitHub URLs, which the board appends
  to the text it then sends to the existing routes.
  `server/middleware/fixtures.ts` applies `fixtureRefusal` (`service.ts`): under
  `FACTORY_FIXTURES=1` every API write is a 403, and read routes branch on `useFixtures()`.
- `fixtures/board/` — the sample project fixture mode serves: a nested
  `.factory/` (config, jobs) plus `fixture.json` (running, errors, events, checks).
- `app/` — the board (Nuxt UI v4, SPA: `ssr: false`). Shared live state is
  `useBoard()` in `app/composables/useBoard.ts` (state + SSE + `act()` for
  POSTs that toast refusals); `state.queued` comes from `/api/state` and the
  `queued` event. The UI imports engine types from
  `~~/server/factory/types`. `COLUMNS` and the board's selection helpers
  (`columnIndex`, `selectedJobId`, `escapeAction`, `fileWriter`) are in
  `app/utils/board.ts`. A card's round chips come from `roundChips` in
  `app/utils/chips.ts`, pulse only while the job is in `state.running`, and use
  the `ring-pulse` animation defined in `app/assets/css/main.css`. Job details render in `app/components/JobDetail.vue`
  inside the board's panel at `/?job=<id>`; `/jobs/:id` only redirects there.
  Layout: the shell (`app/app.vue`) gives pages a viewport-tall scroll
  region under the header, and pages that want fixed headers with scrolling
  panels fill it with `h-full` / `min-h-0` and scroll their own panels;
  in a wide panel JobDetail shows Live activity as a right-hand column that
  scrolls its own lines, and stacks it below the document when narrower.
  Board columns fit their content between a 100px minimum and the board
  height (`100cqh` of the strip's viewport), and scroll their own cards past that.
  The board row is the strip and, when open, the job panel. The general feed
  (`app/components/ActivityFeed.vue`) lives on its own `/activity` page, which
  fills the shell's height and scrolls its own feed. It renders `feed`, the
  merged live feed of status lines and agent output in `useBoard()`, with its
  grouping, at-bottom and status-line helpers in `app/utils/feed.ts`; it keeps
  collecting on every page because the stream is opened in `app/app.vue`.
  Every scroll region is a `UScrollArea` (use `as` for semantic elements);
  never put raw `overflow-*-auto` on a new one. The shared thin, hidden-until-
  scrolling bar is the `scrollbar-auto-hide` utility in `app/assets/css/main.css`,
  applied to all of them by `ui.scrollArea` in `app/app.config.ts` (and to
  `.md pre`); `app/plugins/scrollbars.client.ts` sets `data-scrolling` while a
  region scrolls.

## Dev server on a given port

Run `bun install` first in a fresh checkout. Then, from the repo root:

```sh
FACTORY_FIXTURES=1 bun run dev --port <n>
```

`FACTORY_FIXTURES=1` serves the sample jobs in `fixtures/board/` (several
columns, a running job, one waiting on you, a two-round review, a merged job,
activity events). It takes no `orchestrator.lock`, starts no jobs, runs no
`gh`, `git` or `claude`, writes nothing, and answers every API write with a
403. `FACTORY_PROJECT` is ignored in this mode. Stop only the server on your
port when done (`lsof -tiTCP:<n> -sTCP:LISTEN`).

Never point a second board at a live project (`FACTORY_PROJECT=…` or the
project's own checkout): `orchestrator.lock` refuses it while the factory
runs, and if it started it could act on real jobs.

## Rules

- Bun only: `bun install`, `bun run …`, `bun test`. No npm/pnpm/yarn, and no
  new dependencies unless the issue asks for one.
- Test first. Engine behaviour gets a `bun test` file next to the code
  (`*.test.ts`), using the fakes in `server/factory/testing.ts` instead of
  real `gh`, git remotes or Claude. Write the failing test, then the change.
- Pure helpers used by the UI live in `app/utils/` and are tested from
  `server/factory/*.test.ts` (see `render.test.ts`).
- Before you finish, all of these must pass (they are `.factory/checks.sh`):
  `bun run lint && bun run typecheck && bun run test && bun run build`.
  `bunx eslint --fix <paths>` fixes the style rules (single quotes, one Vue
  attribute per line, nuxt config key order).
- Lint rules that bite: no `void` inside union types; rethrown errors carry
  `{ cause: err }`; unknown Tailwind classes fail (custom classes must be
  defined in `app/assets/css/main.css` and allowed in `eslint.config.mjs`).
- Never render untrusted markdown with `v-html` except through
  `renderMarkdown` in `app/utils/markdown.ts`, which escapes raw HTML.
- Keep the trust boundary: issue text is data, agents write only their own
  files, merges go only through `gh pr merge`. Do not weaken
  `server/factory/agents/runner.ts` (protected) or the local-only middleware.
- Comments explain why, not what. English for code, commits and docs.
