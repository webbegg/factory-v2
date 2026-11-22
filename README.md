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
                                │            └ conflict with base → build while rounds remain
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

The board's **Setup** page (`/setup`) runs the same checks as `factory doctor`,
can run `factory init` for you and shows `.factory/checks.sh`; it works before
the project has a `.factory/`.

The **New request** form and a job's feedback / answer box accept screenshots:
**Add screenshot** captures one frame of a screen or window, and you can paste
or drop images too. Up to 5 images per message, 5 MB each, PNG, JPEG or WebP.
They are uploaded when you send and appended to the text as markdown images.

| Command | |
|---|---|
| `factory [ui] [--port n] [--no-open]` | the board: run the queue, follow jobs, answer what waits on you |
| `factory run [issue]` | headless: drain the queue (or one issue) and exit |
| `factory status` | jobs, stages, PRs, cost |
| `factory init` / `factory doctor` | set up / check a project (also on the board's Setup page) |
| `factory --version` / `-v` | print the factory version |

Start with `"concurrency": 1` in `.factory/config.json` and read every PR until
you trust it. Commit and push `.factory/config.json`, `.factory/checks.sh` and any
`.factory/agents/<agent>.md` prompt overrides: the gate and the agents use the
copies on `origin/<base>`, never the working copy; job state and worktrees are
gitignored. The board's Settings page edits `.factory/config.json` and applies
it to the running factory without a restart; the change still needs committing.

Running one issue (**Run issue** on the board, or **Run it now** on New request)
while every slot is busy queues it: the board shows it as queued, and it starts on
its own when a slot frees up, ahead of what the drain would pick. The queue lives
in the running factory and is not kept across a restart.

## Guardrails

- Only issues labeled `factory` run; labels need triage access. Issue text
  reaches agents only as quoted data in `issue.md`, with comments from the
  author and the operator only.
- Each agent may write only its own file (the builder: its worktree and
  `build.md`); other Write/Edit calls are denied. Their shell is guarded too:
  no agent may merge, ready, close or review a PR, write to GitHub through
  `gh`, or change git config; only the builder commits, and it may push only
  its own branch, without force. The guard reads commands, it is not a sandbox,
  so protect the base branch on GitHub as well. After every agent the factory
  also checks what it changed: any job file other than its report is put back
  and the job stalls, and so does an agent that only reads but moved the branch
  or left uncommitted files.
- The gate runs `checks.sh` as committed on `origin/<base>`, and fails a branch that adds,
  edits, deletes or renames a file under `protectedPaths` (default
  `.factory/checks.sh`, `.factory/config.json`, `.github/*`) or anywhere in
  `.factory/`, which is always protected. Merges happen only through `gh pr merge`, after a re-sync
  and a second gate. The factory never deploys.
- The board listens on 127.0.0.1, refuses foreign `Host` headers and non-JSON
  writes.
- Attached screenshots are uploaded to GitHub as user attachments of the
  project's repository (the way `gh issue create --attach` does it); nothing is
  committed or released. Anyone who can see the repository can open them:
  everyone for a public repo, people with access for a private one. They are
  never deleted by the factory.

## Develop

```bash
bun test            # engine: state machine, queue, gate, merge, orchestrator
bun run lint && bun run typecheck
bun run dev         # board against FACTORY_PROJECT=/path/to/project
```

Engine: `server/factory/`. API: `server/api/`. Board: `app/`.
