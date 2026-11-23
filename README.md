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

On the board, an escalated job's **Merge** button approves it: the factory
syncs with the base, gates again, and merges through `gh pr merge`, as after an
APPROVE. Gating again reuses the round gate's pass, without re-running
`checks.sh`, when the sync left HEAD unchanged and `origin/<base>` is still the
`BASE:` that pass recorded. A PR you merge by hand on GitHub moves its job to merged.

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

`limits` in `.factory/config.json` caps each `checks.sh` run (`checksMinutes`,
default 30; it and everything it started are killed) and each agent run
(`agentTurns`, default 300; `agentBudgetUsd`, default 15). A job that hits one
stalls with the reason, like any other failure. An agent whose report is
missing or whose first line isn't valid is asked once more, with the error,
before the job stalls; `spec.md` must have a `## Acceptance criteria` section,
and a review without a verdict is removed and run again. A stalled job's error is kept
in its `job.json`, so it stays stalled across a restart until you retry it.
Retrying a job that stalled in the middle of a stage change doesn't repeat the
comments or labels that change already posted.
Stopping the factory aborts running agents and checks; a job stopped that way
is not marked as failed and resumes on the next start. Cancel on the board
pauses a job instead of stalling it: it stays paused until you click Resume,
and after a restart it simply shows Resume.

Each job folder has an `events.jsonl`: one JSON line per stage change, agent
run (start and end, with model, round, seconds, cost and any error), gate and
merge attempt. Only the factory writes it.

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
  `gh`, or pass or change git config; read-only agents run only git reads, and
  the builder pushes only by naming its own branch, without force. The guard
  reads commands, it is not a sandbox: a shell that writes files or builds a
  command it can't read still runs as you, so protect the base branch on
  GitHub. After every agent the factory also checks what it changed: any job
  file other than its report (links included, `events.jsonl` too), the job's
  routing, stage and error in `job.json`, or a report whose verdict differs
  from the agent's reply, is put back or refused and the job stalls, and so does an agent that only reads but
  moved the branch or left uncommitted files. Reviewers run one after another,
  so each can be held to its own verdict.
- The gate runs `checks.sh` as committed on `origin/<base>`, fetched right before, and fails a branch that adds,
  edits, deletes or renames a file under `protectedPaths` (default
  `.factory/checks.sh`, `.factory/config.json`, `.github/*`) or anywhere in
  `.factory/`, which is always protected. Merges happen only through `gh pr merge`, after a re-sync
  and a second gate. The factory never deploys.
- `checks.md` and `merge-checks.md` start with `GATE:`, `COMMIT:` (the
  worktree HEAD) and `BASE:` (the `origin/<base>` sha the checks ran against).
  The round gate skips `checks.sh` when the builder's last stop check
  (recorded in the factory's memory, never in a file an agent can write) or
  this round's `checks.md` passed on a clean worktree at the same HEAD and
  `BASE:`; the merge gate skips it only when the sync left HEAD unchanged and
  the round's `checks.md` passed against the current `origin/<base>`. A
  skipped run is written down with its source, only a PASS is reused, and
  protected paths are checked every time.
- `checks.sh` runs without environment variables named like secrets (`*TOKEN*`,
  `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*CREDENTIAL*`, `AUTH`), so branch code
  never sees the factory's credentials; checks that need one must get it some
  other way. Text the factory posts on GitHub or shows as an error has
  credentials in URLs and GitHub/Anthropic tokens masked.
- The board listens on 127.0.0.1, refuses foreign `Host` headers, API calls
  from any other origin (other localhost ports included, where job dev servers
  run branch code) and non-JSON writes.
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
