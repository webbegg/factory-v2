import { basename, resolve } from 'node:path'
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
// in their prompts. It reads every `git`/`gh` word in the command, quotes and
// `bash -c` included, so it errs on refusing; it is a guard, not a sandbox:
// the orchestrator also checks what each agent changed after it runs.

/** Commands of a shell line, as word lists. Quotes are dropped so `bash -c "…"` is read too. */
function commandWords(command: string): string[][] {
  return command.replace(/["']/g, ' ')
    .split(/&&|\|\||[;|&\n`()]|\$\(/)
    .map(part => part.trim().split(/\s+/).filter(Boolean))
    .filter(words => words.length)
}

/** git subcommands that change the branch, the index, the worktree or refs */
const GIT_WRITES = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'push',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'update-ref', 'worktree'
])
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin'])
const PUSH_FLAGS_REFUSED = /^(-f|--force.*|-d|--delete|--mirror|--all|--tags|--prune)$/
const GH_READS = new Set(['view', 'list', 'status', 'diff', 'checks', 'watch'])
const GH_FREE = new Set(['search', 'help', 'version', '--version', 'browse'])

function gitRefusal(args: string[], agent: string, branch: string | undefined): string | null {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    const opt = args[i]!
    if (opt === '-c' && /^alias\./.test(args[i + 1] ?? '')) return `${agent} may not define git aliases`
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(opt) ? 2 : 1
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub) return null
  if (sub === 'config' && !rest.some(a => GIT_CONFIG_READS.has(a))) return `${agent} may not change git config`
  if (agent !== 'builder') {
    const branchWrite = sub === 'branch' && rest.some(a => !a.startsWith('-') || /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force)/.test(a))
    if (GIT_WRITES.has(sub) || branchWrite) return `${agent} may not run git ${sub}: it reads the branch, it doesn't change it`
    return null
  }
  const switches = (sub === 'switch')
    || (sub === 'checkout' && rest.some(a => /^(-b|-B|--orphan|--detach)$/.test(a)))
    || (sub === 'branch' && rest.some(a => /^(-f|-m|-M|-c|-C|-u|--force|--move|--copy|--set-upstream-to.*)$/.test(a)))
  if (switches) return `the builder stays on its branch ${branch ?? ''}: no git ${sub} ${rest.join(' ')}`.trim()
  if (sub !== 'push') return null
  const flag = rest.find(a => PUSH_FLAGS_REFUSED.test(a))
  if (flag) return `the builder may not push with ${flag}`
  const [remote, ...refs] = rest.filter(a => !a.startsWith('-'))
  if (remote !== undefined && remote !== 'origin') return `the builder may push only to origin, not ${remote}`
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
    const method = args.find((a, k) => /^(-X|--method)$/.test(args[k - 1] ?? '') || /^--method=/.test(a))
    const writes = (method && !/^(--method=)?GET$/i.test(method)) || args.some(a => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a))
    return writes ? `${agent} may only read through gh api (GET without fields)` : null
  }
  if (group === 'auth') return sub === 'status' ? null : `${agent} may not run gh auth ${sub}`
  if (GH_READS.has(sub) && !['secret', 'variable'].includes(group)) return null
  if (group === 'pr' && agent === 'builder' && ['create', 'edit', 'comment'].includes(sub)) return null
  return `${agent} may not run gh ${group} ${sub}`.trim() + ': the factory makes GitHub changes itself'
}

/** Why a shell command is refused for this agent, or null to let it run. */
export function bashRefusal(command: string, agent: AgentName, branch?: string): string | null {
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
          env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'factory-v2' },
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
