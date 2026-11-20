import { resolve } from 'node:path'
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
          systemPrompt: { type: 'preset', preset: 'claude_code', append: task.systemPrompt },
          tools: task.tools,
          allowedTools: task.tools,
          permissionMode: 'dontAsk',
          settingSources: [],
          env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'factory-v2' },
          hooks: {
            PreToolUse: [{
              hooks: [async (input) => {
                if (input.hook_event_name !== 'PreToolUse' || !WRITE_TOOLS.has(input.tool_name)) return {}
                const target = toolTarget(input.tool_input)
                if (target && isWritable(target, task.writable)) return {}
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: `The factory only lets ${task.agent} write: ${task.writable.join(', ')}`
                  }
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
