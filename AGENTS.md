# Working in this repo

This is the software factory itself: a Bun CLI (`bin/factory.ts`) that serves a
Nuxt UI board and drives GitHub issues to merged PRs. README.md has the user's
view; this file is for whoever changes the code.

## Layout

- `server/factory/` — the engine, plain TypeScript with no Nuxt imports:
  `machine.ts` (stage transitions, each justified by files on disk; it
  re-exports `TERMINAL` and `WAITING`, which live in `types.ts` so the board
  can import them),
  `store.ts` (job.json + per-step markdown; `appendEvent` adds a line to the
  job's `events.jsonl` and never throws; `list()` skips `<id>.rejected-<n>`
  folders, which `archiveJob` makes, while `Queue.create` numbers new ids
  above every entry, archives included; a move's unrepeatable steps — comments,
  labels, PR close, remote branch delete, the `intake.md` rename — are recorded
  in `job.json` `move` as each finishes, skipped on a retry of the same move,
  and cleared when the move is saved, and `Machine.answer` posts the operator's
  reply as one of these steps), `queue.ts`, `gate.ts`,
  `route.ts`, `merge.ts` (after the push it polls `commitChecks` on the gated
  commit per `ci.wait` / `ci.startMinutes` / `ci.minutes`, through injectable
  `sleep`/`now` that `makeEnv()` fakes; the jobs inside that wait are
  `Merger.ciWaiting`, sent as the `ci` event and as `/api/state` `ciWaiting`;
  right before `prMerge` it fetches and compares `origin/<base>` with the
  gate's `base`, repeating sync, gate, push and CI wait at most twice in the
  same round; after the merge it reads `prMergeCommit` and, for `merge` and
  `squash`, compares its tree with `git.tree` of the gated commit, sending a
  mismatch to needs-human; it saves `job.merge` and `merge.md` through
  `Machine.recordMerge`, never overwriting a record, with `by` from
  `job.mergeVia`, which the machine sets on the move into merging; the
  machine records `by: 'external'` on a move to merged with no record yet;
  `Queue.sweepMerged` skips a job whose `treeVerified` is `false`),
  `orchestrator.ts` (its in-memory FIFO of issues
  queued by `runIssue` while every slot is busy, started by `fill()` ahead of
  the drain, sent as the `queued` event; `agent()` re-prompts an agent once,
  in the same session, when its report is missing or its first line invalid,
  while the builder's one second try stays in `build()`), `agents/` (prompts and the
  Claude Agent SDK runner), `gh.ts` / `git.ts` (adapters behind `ports.ts`),
  `setup.ts` (`init` / `doctor`; `init` writes the commented prompt addenda
  through `scaffoldAddenda`, which is unit-tested on its own; `baseChecks` runs `checks.sh` on
  `origin/<base>` in a temporary detached worktree through the gate's
  `runChecksScript`, and `doctor(repo, { baseChecks: true })`, used only by the
  CLI, includes it), `service.ts` (what the server and CLI share;
  `jobFiles` lists a job's `.md` files and each round's `.log` files, which
  `JobFiles` shows as plain text),
  `attachments.ts` (image upload limits and `validateUpload`; no Node imports,
  the board imports it too).
  `events.jsonl` gets `stage` lines from `Machine` (advance, feedback,
  approve, reject, after job.json is saved) and agent, gate and merge lines from
  `orchestrator.ts`, which writes `agent-start` before an agent's watch is
  taken and `agent-end` after its check so its own lines are never undone,
  and `pr` lines (the PR's state on GitHub and a note) from `orchestrator.ts`
  and `merge.ts` whenever they act on a PR merged or closed outside the
  factory, or on a merge whose `gh pr merge` response was lost.
  `agent-start` also records `sessionId` (the session resumed, null when new),
  `attempt` (2 for an `again` run), `head` (the worktree's, null at intake),
  `base` and `prompt` (`source` builtin/override/addendum and the `hash` of the
  exact `systemPrompt`, all from `prompt()`); `agent-end` keeps only agent,
  model and round. `gate` lines carry `GateResult.base`; `merge` lines carry
  the `commit` and `base` of that attempt's merge gate from `Merger.gated`,
  cleared at each attempt's start, so both are null when no gate ran.
  `job.json` `provenance` is written once by `Queue.create` (best effort: a
  failed read nulls only its field), is in `TRUSTED`, and is absent in older
  jobs. Its build info comes from `buildInfo()` in `provenance.ts`, read once
  per process and injected into `createFactory` (`makeEnv()` passes
  `FAKE_BUILD`); `ui()` reads the package's git sha when it takes the board's
  snapshot and passes it in `FACTORY_BUILD_SHA`, so a later commit can't change it.
  A driver failure is saved as `job.json` `error` (not for a shutdown abort),
  cleared by `start()` and by every stage move, and read back into
  `Orchestrator.errors` by `loadErrors()`, which `createFactory()` awaits.
  A cancel is not saved as an error: once the driver stops it puts the job in
  `Orchestrator.paused` and saves `job.json` `paused` (`by`, `at`, `reason`;
  in `TRUSTED`; never for a shutdown abort), which `start()` clears and
  `loadErrors()` reads back into `Orchestrator.paused`. The drain skips a
  paused job and `Queue.rows()` shows it as a `skip` row, while it still holds
  its slot; `/api/state` sends `paused` and the `paused` event announces it.
- `server/api/` — Nitro routes over `useFactory()` (`server/utils/factory.ts`).
  Engine refusals throw `Refused`; routes wrap calls in `guarded()` → 409.
  The setup routes (`server/api/setup/`) use `projectDir()` instead of
  `useFactory()` so they work before `.factory/config.json` exists;
  `setup/base-checks.post.ts` is the slow base `checks.sh` run, kept off
  `GET /api/setup`.
  `server/middleware/local-only.ts` applies `requestRefusal` (`service.ts`):
  foreign Host headers, API calls from another Origin or with
  `Sec-Fetch-Site` other than same-origin/none, and non-JSON writes are
  refused: keep every new write route a JSON POST, and keep GET routes
  read-only (the merged sweep runs in the orchestrator's tick, not in
  `/api/queue`; while paused, the board's `/api/merged` POST is the check
  for needs-human jobs merged by hand, on load and when a job panel opens).
  `server/api/jobs/[id]/[action].post.ts` takes feedback, reject, answer,
  merge (the board's Merge on an escalated job: `Orchestrator.approve`),
  retry (also the board's Resume), cancel (pauses) and rerun (Run again:
  `Orchestrator.runAgain` archives a rejected job's folder). `server/api/uploads.post.ts`
  takes images as base64 JSON and returns GitHub URLs, which the board appends
  to the text it then sends to the existing routes.
  `server/middleware/fixtures.ts` applies `fixtureRefusal` (`service.ts`): under
  `FACTORY_FIXTURES=1` every API write is a 403, and read routes branch on `useFixtures()`.
- `fixtures/board/` — the sample project fixture mode serves: a nested
  `.factory/` (config, jobs) plus `fixture.json` (running, errors, events, checks).
- `app/` — the board (Nuxt UI v4, SPA: `ssr: false`). Shared live state is
  `useBoard()` in `app/composables/useBoard.ts` (state + SSE + `act()` for
  POSTs that toast refusals); `state.queued` comes from `/api/state` and the
  `queued` event. When the browser closes the stream, `useBoard()` reopens it
  after the `reconnectDelay` backoff in `app/utils/reconnect.ts` (one stream and
  one pending timer at most), refetches `/api/state` on every open, and skips
  frames that aren't JSON with a `console.warn`. While the stream is down the
  shell shows a "Reconnecting…" banner under the header. The UI imports engine types from
  `~~/server/factory/types`. `COLUMNS` and the board's selection helpers
  (`columnIndex`, `selectedJobId`, `escapeAction`, `fileWriter`, `toneColor`)
  are in `app/utils/board.ts`, with `LIVE_STAGES`, built from `STAGES` minus
  `TERMINAL` and `WAITING`. A card's round chips come from `roundChips` in
  `app/utils/chips.ts`, pulse only while the job is in `state.running` (in a
  review only the first routed reviewer without a verdict runs), and use
  the `ring-pulse` animation defined in `app/assets/css/main.css`.
  `app/utils/waiting.ts` is the single definition of "waiting on you"
  (needs-human or stalled, each once; needs-info waits on the author), used by
  the tab title, the Inbox badge, the Inbox and the browser notifier in
  `app/app.vue`; the notification opt-in is a `localStorage` flag in
  `app/composables/useNotifications.ts`, never in config. Job details render in `app/components/JobDetail.vue`
  inside the board's panel at `/?job=<id>`; `/jobs/:id` only redirects there.
  `JobDetail` is the shell: it fetches the detail, holds the live flags, the
  Stalled/Paused alerts and the panel grid, and composes `JobHeader` (meta,
  links, the run actions and their modals), `JobDecision` (the needs-human /
  needs-info form, shown for `WAITING` stages), `JobFiles` (the file list and
  viewer, loading through `useJobFile` in `app/composables/useJobFile.ts`,
  which drops responses for a file or job the user has left) and
  `JobActivity` (the job's Live activity lines).
  Layout: the shell (`app/app.vue`) gives pages a viewport-tall scroll
  region under the header, and pages that want fixed headers with scrolling
  panels fill it with `h-full` / `min-h-0` and scroll their own panels;
  in a wide panel JobDetail's grid shows Live activity as a right-hand column that
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
  `renderMarkdown` in `app/utils/markdown.ts`, which escapes raw HTML and
  renders `https://` images only.
- Keep the trust boundary: issue text is data, agents write only their own
  files, merges go only through `gh pr merge`. Do not weaken
  `server/factory/agents/runner.ts` (protected) or the local-only middleware.
- Comments explain why, not what. English for code, commits and docs.
