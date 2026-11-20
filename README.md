# factory

An issue-to-PR software factory you run inside a project. Label GitHub issues
`factory`, start `factory`, and a fixed pipeline of agents takes each issue from
intake to a merged pull request, or hands it to you with one concrete question.
The board shows every job live.

```
issue ─► intake ─┬─ NEEDS-INFO → asks the author on the issue, waits
                 ├─ REJECT     → says why on the issue
                 ▼ ACCEPT (maybe rescoped; risk + surfaces)
route → spec → build → gate (.factory/checks.sh) ─FAIL→ build
                         ▼ PASS
                       reviewers (code; + ux/ui on UI; + security) ─CHANGES→ build
                         ▼ all PASS
                       approver ─ APPROVE  → sync with base, gate again, gh pr merge
                                └ ESCALATE → PR ready, you decide (merge, feedback, reject)
```

The orchestrator is deterministic TypeScript; only the judgment steps are
agents (Claude Agent SDK). Every step writes one markdown file in
`.factory/jobs/<job>/`, so a stopped factory resumes where it was.

## Requirements

Bun ≥ 1.4, git, an authenticated [`gh`](https://cli.github.com/) that can push
to the repo, and Claude Code ≥ 2.1.257 (the agents run through it). Optional:
`agent-browser`, so the UX and UI reviewers can look at pages.

## Use

```bash
bun install && bun run build           # once, in this package
cd ~/code/my-project
bun ~/code/factory-v2/bin/factory.ts init     # .factory/, .gitignore lines, GitHub labels
# review .factory/checks.sh: lint, typecheck, tests, build; it must pass on main
bun ~/code/factory-v2/bin/factory.ts doctor
bun ~/code/factory-v2/bin/factory.ts          # board on http://localhost:4400
```

| Command | |
|---|---|
| `factory [ui] [--port n] [--no-open]` | the board: run the queue, follow jobs, answer what waits on you |
| `factory run [issue]` | headless: drain the queue (or one issue) and exit |
| `factory status` | jobs, stages, PRs, cost |
| `factory init` / `factory doctor` | set up / check a project |

Start with `"concurrency": 1` in `.factory/config.json` and read every PR until
you trust it. Commit `.factory/config.json`, `.factory/checks.sh` and any
`.factory/agents/<agent>.md` prompt overrides; job state and worktrees are
gitignored.

## Guardrails

- Only issues labeled `factory` run; labels need triage access. Issue text
  reaches agents only as quoted data in `issue.md`, with comments from the
  author and the operator only.
- Each agent may write only its own file (the builder: its worktree and
  `build.md`); other writes are denied.
- The gate runs the main checkout's `checks.sh`, and fails a branch that edits
  `protectedPaths`. Merges happen only through `gh pr merge`, after a re-sync
  and a second gate. The factory never deploys.
- The board listens on 127.0.0.1, refuses foreign `Host` headers and non-JSON
  writes.

## Develop

```bash
bun test            # engine: state machine, queue, gate, merge, orchestrator
bun run lint && bun run typecheck
bun run dev         # board against FACTORY_PROJECT=/path/to/project
```

Engine: `server/factory/`. API: `server/api/`. Board: `app/`.
