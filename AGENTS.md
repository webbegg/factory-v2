# Working in this repo

This is the software factory itself: a Bun CLI (`bin/factory.ts`) that serves a
Nuxt UI board and drives GitHub issues to merged PRs. README.md has the user's
view; this file is for whoever changes the code.

## Layout

- `server/factory/` — the engine, plain TypeScript with no Nuxt imports:
  `machine.ts` (stage transitions, each justified by files on disk),
  `store.ts` (job.json + per-step markdown), `queue.ts`, `gate.ts`,
  `route.ts`, `merge.ts`, `orchestrator.ts`, `agents/` (prompts and the
  Claude Agent SDK runner), `gh.ts` / `git.ts` (adapters behind `ports.ts`),
  `setup.ts` (`init` / `doctor`), `service.ts` (what the server and CLI share),
  `attachments.ts` (image upload limits and `validateUpload`; no Node imports,
  the board imports it too).
- `server/api/` — Nitro routes over `useFactory()` (`server/utils/factory.ts`).
  Engine refusals throw `Refused`; routes wrap calls in `guarded()` → 409.
  The setup routes (`server/api/setup/`) use `projectDir()` instead of
  `useFactory()` so they work before `.factory/config.json` exists.
  `server/middleware/local-only.ts` rejects foreign Host headers and non-JSON
  writes: keep every new write route a JSON POST. `server/api/uploads.post.ts`
  takes images as base64 JSON and returns GitHub URLs, which the board appends
  to the text it then sends to the existing routes.
- `app/` — the board (Nuxt UI v4, SPA: `ssr: false`). Shared live state is
  `useBoard()` in `app/composables/useBoard.ts` (state + SSE + `act()` for
  POSTs that toast refusals). The UI imports engine types from
  `~~/server/factory/types`. `COLUMNS` and the board's selection helpers
  (`columnIndex`, `selectedJobId`, `escapeAction`, `fileWriter`) are in
  `app/utils/board.ts`. Job details render in `app/components/JobDetail.vue`
  inside the board's panel at `/?job=<id>`; `/jobs/:id` only redirects there.

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
