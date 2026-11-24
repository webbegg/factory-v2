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
The factory reads the PR on GitHub before it acts on feedback, an answer, a
reject or a builder round: a PR already merged moves the job to merged, and a
PR closed on GitHub sends a builder round to needs-human and refuses feedback or
an answer (a reject still rejects, without closing the PR again). A `gh pr
merge` that fails while GitHub shows the PR merged, as when its response is
lost, ends in merged, noted in `merge-checks.md`.

The board's **Inbox** lists what waits on you: escalated (needs-human) jobs and
stalled jobs, each once. Jobs whose intake asked the issue's author a question
are listed apart, under "Waiting on the author", and don't count. The tab title
shows that count, e.g. `(2) Factory`, as does the Inbox badge in the header.
Browser notifications for a job that newly needs your call or stalls are opt-in:
turn them on in Settings, which is the only place the browser asks for
permission. The choice is kept per browser, and notifications arrive only while
the board is open.

The orchestrator is deterministic TypeScript; only the judgment steps are
agents (Claude Agent SDK). Every step writes one markdown file in
`.factory/jobs/<job>/`, so a stopped factory resumes where it was.

## Requirements

Bun ≥ 1.4, git, an authenticated [`gh`](https://cli.github.com/) that can push
to the repo, and Claude Code ≥ 2.1.257 (the agents run through it). Optional:
`agent-browser`, so the UX and UI reviewers can look at pages (not under the
sandbox, below), and for the agent sandbox on Linux, `bubblewrap` and `socat`
(macOS has `sandbox-exec` built in).

## Use

```bash
bun install && bun run build           # once, in this package
cd ~/code/my-project
bun ~/code/factory-v2/bin/factory.ts init     # .factory/, .gitignore lines, GitHub labels
# review .factory/checks.sh: lint, typecheck, tests, build; it must pass on main
bun ~/code/factory-v2/bin/factory.ts doctor   # runs checks.sh on origin/main, checks mergeMethod, AGENTS.md
bun ~/code/factory-v2/bin/factory.ts          # board on http://localhost:4400
```

`factory doctor` runs `checks.sh` as committed on `origin/<base>` in a
temporary worktree, the way the gate does (a red base fails every job), checks
that the repo allows the configured `mergeMethod`, and warns when `AGENTS.md`
(or `CLAUDE.md`) never mentions a port, since UX/UI reviewers need the
dev-server instructions to look at the app.

The board's **Setup** page (`/setup`) runs the same checks as `factory doctor`,
except the slow base run, which has its own **Run checks on base** button; it
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
`.factory/agents/<agent>.md` prompt overrides and `.factory/agents/<agent>.append.md`
addenda: the gate and the agents use the copies on `origin/<base>`, never the
working copy; job state and worktrees are gitignored. An override replaces the
built-in prompt; an addendum is added after it under a `## This project` heading,
so the factory's own rules stay. The override wins if both exist, an addendum
that is only HTML comments is ignored, and `factory init` scaffolds commented
addenda for intake, approver and the security, ui and ux reviewers. The board's Settings page edits `.factory/config.json` and applies
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

`ci` in `.factory/config.json` makes a merge wait for GitHub CI on the gated
commit, between the push and `gh pr merge`. The factory polls that commit's
check runs and commit statuses every 15 seconds. When every check passed
(success, neutral or skipped), it merges. When any check failed, was cancelled
or timed out, the job goes to needs-human with the failing checks named. When
no check appeared within `startMinutes` (default 2) of the push, the commit has
no CI, so it merges and notes that in `round-N/merge-checks.md`. When checks are
still pending `minutes` (default 30) after the push, the job goes to
needs-human, naming them. `wait` (default `true`) set to `false` restores
merging right after the local gate. Merges run one at a time, so the next one
queues behind a job's CI wait, for up to `ci.minutes`. The board shows the job
as "merging: waiting for CI" meanwhile. Because the factory now waits, the base
branch's protection can require the CI check.
Stopping the factory aborts running agents and checks; a job stopped that way
is not marked as failed and resumes on the next start. Cancel on the board
pauses a job instead of stalling it: it stays paused until you click Resume,
and after a restart it simply shows Resume.

A rejected job can be run again from its panel on the board (**Run again**).
Its folder is kept as `.factory/jobs/<id>.rejected-<n>` and no longer counts as
a job, so the issue gets a fresh job, with a new number, on the next drain or
Run issue. Run again doesn't touch labels: the issue needs the `factory` label
to get that new job.

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
  command it can't read still runs as you (unless the sandbox below is on), so
  protect the base branch on GitHub. After every agent the factory also checks what it changed: any job
  file other than its report (links included, `events.jsonl` too), the job's
  routing, stage and error in `job.json`, or a report whose verdict differs
  from the agent's reply, is put back or refused and the job stalls, and so does an agent that only reads but
  moved the branch or left uncommitted files. Reviewers run one after another,
  so each can be held to its own verdict.
- Opt-in agent sandbox: `"sandbox": { "enabled": true, "domains": [] }` in
  `.factory/config.json` runs every agent's shell in the Claude Agent SDK
  sandbox, and an agent run fails if the sandbox can't start (`doctor` says
  whether it can). A shell may write the agent's own files and its working
  folder, the job's worktree (the SDK always allows that; after a read-only
  agent the factory still checks that HEAD didn't move and no files were
  left). No shell may write the repo's `.git`, which the SDK would otherwise
  open to a shell in a worktree, so no agent can move refs, plant objects or
  redirect git. The builder therefore doesn't commit, push or open its PR:
  it leaves its changes in the worktree, and each time it stops the factory
  commits all of them (titled from the `# Build:` line of `build.md`, refused
  while conflict markers are left), pushes the branch and opens the draft PR.
  On a conflict round the factory starts the merge and the builder resolves
  the conflicted files. Only the builder reaches the network, and only for
  packages: the npm registry and the hosts in `domains`, never GitHub. The
  builder and the UX and UI reviewers may bind local ports for dev servers.
  Model keys, GitHub tokens and `gh` config are hidden from every shell. The
  factory names refs in full (`refs/remotes/origin/<base>`) whether the
  sandbox is on or not. Verified on macOS; Linux is untested. There is no browser
  under the sandbox, since Chrome can't start in it: agents that view pages are
  told to read the code and `curl` their dev server. The sandbox covers shells
  only. Write and Edit stay with the guard above, and the gate's `checks.sh`
  runs outside it.
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
