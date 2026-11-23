import { basename, join, resolve } from 'node:path'
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk'
import { run } from '../exec'
import type { AgentName } from './prompts'

export interface AgentEvent {
  kind: 'start' | 'text' | 'tool' | 'done' | 'error'
  text: string
}

/** One agent invocation, fully resolved by the orchestrator. */
export interface AgentTask {
  agent: AgentName
  jobId: string
  jobDir: string
  round: number
  model: string
  cwd: string
  systemPrompt: string
  /** the task message: job header plus what this run is for */
  message: string
  tools: string[]
  /** exact files, or folders ending in `/`; Write and Edit anywhere else are denied */
  writable: string[]
  /** the job branch: the only one the builder may push */
  branch?: string
  /** run the agent's shell in the SDK sandbox; `gitDir` is the main checkout's .git */
  sandbox?: { gitDir: string, domains: string[] }
  maxTurns?: number
  maxBudgetUsd?: number
  /** Agent SDK session to continue */
  resume?: string
  /** runs when the agent tries to stop; a string blocks the stop with that reason */
  stopCheck?: () => Promise<string | null>
  signal?: AbortSignal
  onEvent?: (e: AgentEvent) => void
}

export interface AgentResult {
  ok: boolean
  /** the agent's final reply */
  reply: string
  sessionId: string | null
  /** cumulative for the session, as the SDK reports it */
  costUsd: number
  error?: string
}

export interface AgentRunner {
  run(task: AgentTask): Promise<AgentResult>
}

export function isWritable(path: string, writable: string[]): boolean {
  const target = resolve(path)
  return writable.some(w => w.endsWith('/') ? target.startsWith(w) : target === resolve(w))
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function toolTarget(input: unknown): string | null {
  const i = input as Record<string, unknown> | null
  const p = i?.file_path ?? i?.notebook_path ?? i?.path
  return typeof p === 'string' ? p : null
}

// ---- Bash guard -------------------------------------------------------------
//
// Agents get a shell, so the GitHub and git moves that belong to the factory
// (merge, ready, labels, pushes to other branches) are refused here as well as
// in their prompts. It reads every `git`/`gh` word in the command, quotes,
// backslashes and `bash -c` included, so it errs on refusing; it is a guard,
// not a sandbox (a determined shell can still spell a command it can't read):
// the orchestrator also checks what each agent changed after it runs.

/** Words of each command in a shell line, split the way the shell splits them: quotes join, backslashes escape, separators outside quotes end a command. */
function shellCommands(line: string): string[][] {
  const s = line.replace(/\\\n/g, '')
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let quoted = false
  let quote: string | null = null
  const endWord = () => {
    if (word || quoted) words.push(word)
    word = ''
    quoted = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < s.length) word += s[++i]
      else word += c
    } else if (c === '"' || c === '\'') {
      quote = c
      quoted = true
    } else if (c === '\\') {
      if (i + 1 < s.length) word += s[++i]
    } else if (c === '$' && s[i + 1] === '(') {
      endCommand()
      i++
    } else if (';|&\n`()'.includes(c)) {
      endCommand()
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      word += c
    }
  }
  endCommand()
  return out
}

/** Every command in the line, and in any quoted string that could itself be run (`bash -c "…"`), a few levels deep. */
function commandWords(command: string, depth = 0): string[][] {
  const commands = shellCommands(command)
  if (depth >= 3) return commands
  return [...commands, ...commands.flat().filter(w => /[\s;&|`]|\$\(/.test(w)).flatMap(w => commandWords(w, depth + 1))]
}

/** words that run the next word as a command */
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'nice', 'xargs', 'builtin', 'timeout'])

/**
 * A command whose name comes from a variable, `eval`, a substitution, a glob
 * or brace expansion can't be read before it runs, and git config passed
 * through the environment rewires what git does.
 */
function opaqueCommand(command: string): string | null {
  if (/(^|[;&|\n(]\s*)(\$\(|`)/.test(command)) return 'a command named by a substitution'
  for (const words of commandWords(command)) {
    if (words.some(w => /^(export\s+)?GIT_(CONFIG\w*|EXEC_PATH|SSH\w*|ASKPASS)=/.test(w))) return 'git configuration through the environment'
    if (words.some(w => /\$\{?IFS/.test(w))) return 'a command split with IFS'
    let k = 0
    while (k < words.length && (/^\w+=/.test(words[k]!) || WRAPPERS.has(words[k]!) || (k > 0 && WRAPPERS.has(words[k - 1]!) && words[k]!.startsWith('-')))) k++
    const name = words[k]
    if (name && (name.startsWith('$') || name === 'eval' || /[{}*?[\]]/.test(name))) return `a command named '${name}'`
  }
  return null
}

const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin'])
/** what a read-only agent may run: reads that change no ref, index, remote or worktree */
const GIT_READS = new Set([
  'log', 'diff', 'show', 'status', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'blame', 'cat-file', 'merge-base',
  'describe', 'shortlog', 'rev-list', 'name-rev', 'whatchanged', 'check-ignore', 'for-each-ref', 'show-ref',
  'diff-tree', 'var', 'help', 'version', 'branch', 'config', 'remote', 'fetch', 'worktree'
])
/** plumbing the builder never needs and that rewrites refs or remotes behind the gate's back */
const GIT_BUILDER_REFUSED = new Set([
  'update-ref', 'symbolic-ref', 'replace', 'notes', 'filter-branch', 'filter-repo', 'reflog',
  // pushes that skip `git push` and its checks
  'send-pack', 'subtree', 'http-push', 'push-to-checkout'
])
const PUSH_FLAGS_REFUSED = /^(--force.*|--delete|--mirror|--all|--tags|--prune)$|^-[a-zA-Z]*[fd][a-zA-Z]*$/
const GH_READS = new Set(['view', 'list', 'status', 'diff', 'checks', 'watch'])
const GH_FREE = new Set(['search', 'help', 'version', '--version', 'browse'])

function gitRefusal(args: string[], agent: string, branch: string | undefined): string | null {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    const opt = args[i]!
    // `-c remote.origin.push=…`, `-c alias.x=…` and friends rewire what a command does
    if (opt === '-c' || opt.startsWith('--config-env')) return `${agent} may not pass git config on the command line (${opt})`
    i += ['-C', '--git-dir', '--work-tree', '--namespace'].includes(opt) ? 2 : 1
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub) return null
  if (sub === 'config' && !rest.some(a => GIT_CONFIG_READS.has(a))) return `${agent} may not change git config`
  if (sub === 'remote' && rest.some(a => !a.startsWith('-')) && !['show', 'get-url'].includes(rest.find(a => !a.startsWith('-'))!)) {
    return `${agent} may not change git remotes`
  }
  if (sub === 'fetch' && rest.some(a => a.includes(':'))) return `${agent} may not fetch into a named ref (${rest.find(a => a.includes(':'))})`
  if (agent !== 'builder') {
    const branchWrite = sub === 'branch' && rest.some(a => !a.startsWith('-') || /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream)/.test(a))
    const worktreeWrite = sub === 'worktree' && rest[0] !== 'list'
    if (!GIT_READS.has(sub) || branchWrite || worktreeWrite) return `${agent} may not run git ${sub}: it reads the branch, it doesn't change it`
    return null
  }
  if (GIT_BUILDER_REFUSED.has(sub)) return `the builder may not run git ${sub}`
  const switches = (sub === 'switch')
    || (sub === 'checkout' && rest.some(a => /^(-b|-B|--orphan|--detach)$/.test(a)))
    || (sub === 'branch' && rest.some(a => /^(-f|-m|-M|-c|-C|-u|--force|--move|--copy|--set-upstream-to.*)$/.test(a)))
  if (switches) return `the builder stays on its branch ${branch ?? ''}: no git ${sub} ${rest.join(' ')}`.trim()
  if (sub !== 'push') return null
  const flag = rest.find(a => PUSH_FLAGS_REFUSED.test(a))
  if (flag) return `the builder may not push with ${flag}`
  const [remote, ...refs] = rest.filter(a => !a.startsWith('-'))
  if (remote !== undefined && remote !== 'origin') return `the builder may push only to origin, not ${remote}`
  // without a refspec git pushes whatever branch is checked out, so it must be named
  if (!refs.length) return `the builder names its branch on every push: git push -u origin ${branch ?? '<branch>'}`
  for (const ref of refs) {
    const [src, dst = src] = ref.split(':')
    const ours = (r: string | undefined) => !!branch && (r === branch || r === `refs/heads/${branch}`)
    if (ref.startsWith('+') || !src || !ours(dst)) {
      return `the builder may push only its own branch ${branch ?? ''} (got ${ref})`.replace('  ', ' ')
    }
  }
  return null
}

function ghRefusal(args: string[], agent: string): string | null {
  const words = args.filter((a, k) => !a.startsWith('-') && !['-R', '--repo'].includes(args[k - 1] ?? ''))
  const [group = '', sub = ''] = words
  if (GH_FREE.has(group)) return null
  if (group === 'api') {
    // short flags bundle (-iXPUT, -iflabels=x), so -X and -f/-F count anywhere in a cluster
    const methods = args.flatMap((a, k) => {
      if (/^(-[a-zA-Z]*X|--method)$/.test(args[k - 1] ?? '')) return [a]
      const attached = /^(?:-[a-zA-Z]*X|--method=)(.+)$/.exec(a)
      return attached ? [attached[1]!] : []
    })
    const fields = args.some(a => /^(--field|--raw-field|--input)(=|$)|^-[a-zA-Z]*[fF]/.test(a))
    const writes = methods.some(m => m.toUpperCase() !== 'GET') || fields
    return writes ? `${agent} may only read through gh api (GET without fields)` : null
  }
  if (group === 'auth') return sub === 'status' ? null : `${agent} may not run gh auth ${sub}`
  if (GH_READS.has(sub) && !['secret', 'variable'].includes(group)) return null
  if (group === 'pr' && agent === 'builder' && ['create', 'edit', 'comment'].includes(sub)) return null
  return `${agent} may not run gh ${group} ${sub}`.trim() + ': the factory makes GitHub changes itself'
}

/** Why a shell command is refused for this agent, or null to let it run. */
export function bashRefusal(command: string, agent: AgentName, branch?: string): string | null {
  const opaque = opaqueCommand(command)
  if (opaque) return `${agent} may not run ${opaque}: the factory can't check it; write the command out`
  for (const words of commandWords(command)) {
    for (let k = 0; k < words.length; k++) {
      const tool = basename(words[k]!)
      const why = tool === 'git'
        ? gitRefusal(words.slice(k + 1), agent, branch)
        : tool === 'gh' ? ghRefusal(words.slice(k + 1), agent) : null
      if (why) return why
    }
  }
  return null
}

/** The PreToolUse decision: why this tool call is refused, or null. */
export function toolRefusal(tool: string, input: unknown, task: Pick<AgentTask, 'agent' | 'branch' | 'writable'>): string | null {
  if (tool === 'Bash') {
    const command = (input as { command?: unknown } | null)?.command
    return typeof command === 'string' ? bashRefusal(command, task.agent, task.branch) : null
  }
  if (!WRITE_TOOLS.has(tool)) return null
  const target = toolTarget(input)
  if (target && isWritable(target, task.writable)) return null
  return `The factory only lets ${task.agent} write: ${task.writable.join(', ')}`
}

// ---- SDK sandbox ------------------------------------------------------------
//
// The guard reads commands; the sandbox contains what they do. It covers the
// Bash tool only: Write and Edit stay with the PreToolUse hook above.

const GITHUB_HOSTS = ['github.com', 'api.github.com', '*.githubusercontent.com']
const REGISTRY_HOSTS = ['registry.npmjs.org']
/** agents that start a dev server and look at it */
const SERVES = new Set<AgentName>(['builder', 'reviewer-ux', 'reviewer-ui'])
/**
 * Chrome can't start in the sandbox (its singleton socket and crash reporter
 * need the shared user temp folder and Mach services), so with the sandbox on
 * the agents that look at pages are told there is no browser.
 */
export const NO_BROWSER = 'The sandbox is on, so there is no browser: agent-browser won\'t start. Check pages by reading the code and fetching your dev server with curl.'
/** .git/config is read-only in the sandbox, so `git push -u` can't record the upstream; the push itself succeeds */
export const SANDBOX_PUSH = 'The sandbox keeps .git/config read-only, so `git push -u` reports it could not set the upstream: the push itself went through; leave it.'

/** what an agent is told about the sandbox it runs in */
export function sandboxNote(agent: AgentName): string {
  return [agent === 'builder' ? SANDBOX_PUSH : '', SERVES.has(agent) ? NO_BROWSER : ''].filter(Boolean).join(' ')
}
/** the claude process keeps these; no shell needs them */
const MODEL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
/** only the builder pushes and opens its PR */
const GITHUB_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
const SECRET_FILES = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.netrc', '~/.npmrc', '~/.docker/config.json']
const GITHUB_FILES = ['~/.config/gh', '~/.git-credentials']

/**
 * The SDK sandbox for one agent's shell: writes only to its own files (the
 * builder also to what commit and push touch in .git), network only for the
 * builder, and no credentials it doesn't need. Commands may not opt out.
 */
export function sandboxSettings(task: Pick<AgentTask, 'agent' | 'cwd' | 'writable' | 'sandbox'>): SandboxSettings | undefined {
  if (!task.sandbox) return undefined
  const { gitDir, domains } = task.sandbox
  const builder = task.agent === 'builder'
  const worktreeGit = join(gitDir, 'worktrees', basename(task.cwd))
  const allowWrite = task.writable.map(w => w.replace(/\/+$/, ''))
  // objects and refs for commits and the remote-tracking ref a push updates; the worktree's own index and HEAD
  if (builder) allowWrite.push(join(gitDir, 'objects'), join(gitDir, 'refs'), join(gitDir, 'logs'), join(gitDir, 'packed-refs'), worktreeGit)
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite,
      // the shell may write its working folder (the worktree), but never the file that tells git where its repo is
      denyWrite: [
        join(task.cwd, '.git'), join(gitDir, 'config'), join(gitDir, 'hooks'), join(gitDir, 'info'),
        ...(builder ? ['commondir', 'gitdir', 'config.worktree'].map(f => join(worktreeGit, f)) : [])
      ],
      denyRead: builder ? SECRET_FILES : [...SECRET_FILES, ...GITHUB_FILES]
    },
    network: {
      allowedDomains: builder ? [...GITHUB_HOSTS, ...REGISTRY_HOSTS, ...domains] : [],
      strictAllowlist: true,
      allowLocalBinding: SERVES.has(task.agent),
      // macOS: gh (Go) verifies TLS through trustd; the keychain itself stays closed
      ...(builder ? { allowMachLookup: ['com.apple.trustd.agent'] } : {})
    },
    credentials: {
      envVars: [...MODEL_ENV, ...(builder ? [] : GITHUB_ENV)].map(name => ({ name, mode: 'deny' as const }))
    }
  }
}

/**
 * The agent process's environment. A sandboxed builder can't reach the
 * keychain, where gh and git keep the GitHub login, so the factory hands it
 * the token and a git credential helper that reads it. Through the env, not
 * a config file: the guard refuses GIT_CONFIG_* from the agent itself.
 */
export function agentEnv(task: Pick<AgentTask, 'agent' | 'sandbox'>, base: Record<string, string | undefined>, token: string | null): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: 'factory-v2' }
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'factory-v2'
  if (!task.sandbox || task.agent !== 'builder') return env
  if (!env.GH_TOKEN && token) env.GH_TOKEN = token
  const count = Number(env.GIT_CONFIG_COUNT) || 0
  // an empty value first clears any github.com helper from the config files (osxkeychain, say)
  const helpers = ['', '!gh auth git-credential']
  helpers.forEach((value, i) => {
    env[`GIT_CONFIG_KEY_${count + i}`] = 'credential.https://github.com.helper'
    env[`GIT_CONFIG_VALUE_${count + i}`] = value
  })
  env.GIT_CONFIG_COUNT = String(count + helpers.length)
  return env
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const detail = i.command ?? i.file_path ?? i.pattern ?? i.path ?? ''
  return `${name} ${String(detail)}`.trim().slice(0, 300)
}

/** Runs agents through the Claude Agent SDK (headless Claude Code). */
export class SdkRunner implements AgentRunner {
  async run(task: AgentTask): Promise<AgentResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const abortController = new AbortController()
    if (task.signal?.aborted) return { ok: false, reply: '', sessionId: task.resume ?? null, costUsd: 0, error: 'cancelled before it started' }
    task.signal?.addEventListener('abort', () => abortController.abort(), { once: true })
    const emit = (kind: AgentEvent['kind'], text: string) => task.onEvent?.({ kind, text })

    let sessionId: string | null = task.resume ?? null
    let reply = ''
    let costUsd = 0
    let error: string | undefined
    const token = task.sandbox && task.agent === 'builder' && !process.env.GH_TOKEN
      ? await run('gh', ['auth', 'token'], { cwd: task.cwd }).then(r => r.code === 0 ? r.stdout.trim() : null, () => null)
      : null
    try {
      const stream = query({
        prompt: task.message,
        options: {
          cwd: task.cwd,
          model: task.model,
          resume: task.resume,
          abortController,
          maxTurns: task.maxTurns,
          maxBudgetUsd: task.maxBudgetUsd,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: task.systemPrompt },
          tools: task.tools,
          allowedTools: task.tools,
          permissionMode: 'dontAsk',
          settingSources: [],
          sandbox: sandboxSettings(task),
          env: agentEnv(task, process.env, token),
          hooks: {
            PreToolUse: [{
              hooks: [async (input) => {
                if (input.hook_event_name !== 'PreToolUse') return {}
                const reason = toolRefusal(input.tool_name, input.tool_input, task)
                if (!reason) return {}
                return {
                  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
                }
              }]
            }],
            Stop: task.stopCheck
              ? [{
                  hooks: [async (input) => {
                    if (input.hook_event_name !== 'Stop' || input.stop_hook_active) return {}
                    const reason = await task.stopCheck!()
                    return reason ? { decision: 'block', reason } : {}
                  }]
                }]
              : []
          }
        }
      })
      for await (const msg of stream) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id
          emit('start', `${task.agent} on ${task.model}`)
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) emit('text', block.text)
            else if (block.type === 'tool_use') emit('tool', describeTool(block.name, block.input))
          }
        } else if (msg.type === 'result') {
          sessionId = msg.session_id
          costUsd = msg.total_cost_usd
          if (msg.subtype === 'success') reply = msg.result
          else error = `${msg.subtype}: ${msg.errors.join('; ')}`
        }
      }
    } catch (err) {
      error = (err as Error).message
    }
    if (error) emit('error', error)
    else emit('done', reply)
    return { ok: !error, reply: reply.trim(), sessionId, costUsd, error }
  }
}
