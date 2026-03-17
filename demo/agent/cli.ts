#!/usr/bin/env node
/**
 * CodingAgent CLI
 *
 * Single-shot:
 *   npx tsx demo/agent/cli.ts "what does this codebase do?" -C /path/to/project
 *
 * Interactive REPL:
 *   npx tsx demo/agent/cli.ts -i -C /path/to/project
 *
 * Options:
 *   -C, --cwd <path>          Working directory for file/shell tools  (default: .)
 *   -p, --provider <name>     ollama | anthropic                       (default: AGENT_PROVIDER or ollama)
 *   -s, --system <prompt>     Override system prompt
 *       --max-turns <n>       Turn limit                               (default: 20)
 *   -i, --interactive         Multi-turn interactive session
 *   -v, --verbose             Show raw event stream (tool results, turn metadata)
 *   -h, --help                Show this help
 */

import * as fs       from 'node:fs'
import * as path     from 'node:path'
import * as readline from 'node:readline'
import { createCodingAgent, createCodingTools } from './index.js'
import { OllamaProvider, AnthropicProvider, OLLAMA_CLOUD_MODEL_DEFAULTS } from '../../providers/index.js'
import type { ILLMProvider, ModelTier } from '../../contracts/llm.js'
import type { AgentEvent, TurnRecord } from '../../contracts/agent.js'
import type { IModelRouter } from '../../contracts/llm.js'

// ── ANSI colours ──────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
}
const noColour = !process.stdout.isTTY

function c(code: string, text: string): string {
  return noColour ? text : `${code}${text}${C.reset}`
}

// ── Env loading ───────────────────────────────────────────────────────────────

function loadEnv(startDir: string): void {
  // Walk up from startDir looking for a .env file.
  let dir = path.resolve(startDir)
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) {
      const lines = fs.readFileSync(candidate, 'utf8').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (!(key in process.env)) process.env[key] = val
      }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

// ── Provider factory ──────────────────────────────────────────────────────────

function buildRouter(providerName: string): IModelRouter {
  const fastModel     = process.env['AGENT_FAST_MODEL']
  const balancedModel = process.env['AGENT_BALANCED_MODEL']
  const capableModel  = process.env['AGENT_CAPABLE_MODEL']

  if (providerName === 'anthropic') {
    const apiKey = process.env['AGENTIC_ANTHROPIC_API_KEY']
    if (!apiKey || apiKey === 'your-anthropic-api-key') {
      die('AGENTIC_ANTHROPIC_API_KEY is not set. Add it to your .env file.')
    }
    const make = (model: string) => new AnthropicProvider({ apiKey, model })
    const tiers: Record<ModelTier, ILLMProvider> = {
      fast:     make(fastModel  ?? 'claude-haiku-4-5-20251001'),
      balanced: make(balancedModel ?? 'claude-sonnet-4-6'),
      capable:  make(capableModel  ?? 'claude-opus-4-6'),
    }
    return { select: (tier) => tiers[tier] }
  }

  // Default: ollama
  const apiKey  = process.env['AGENTIC_OLLAMA_API_KEY']
  const baseUrl = process.env['AGENTIC_OLLAMA_BASE_URL']
  const numCtx  = process.env['OLLAMA_NUM_CTX'] ? Number(process.env['OLLAMA_NUM_CTX']) : undefined

  const make = (model: string) =>
    new OllamaProvider({ apiKey, baseUrl, model, numCtx })

  const tiers: Record<ModelTier, ILLMProvider> = {
    fast:     make(fastModel     ?? OLLAMA_CLOUD_MODEL_DEFAULTS.fast),
    balanced: make(balancedModel ?? OLLAMA_CLOUD_MODEL_DEFAULTS.balanced),
    capable:  make(capableModel  ?? OLLAMA_CLOUD_MODEL_DEFAULTS.capable),
  }
  return { select: (tier) => tiers[tier] }
}

// ── Event display ─────────────────────────────────────────────────────────────

function makeEventHandler(verbose: boolean): (event: AgentEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'message_end':
        if (event.message.content) {
          process.stdout.write(event.message.content)
          process.stdout.write('\n')
        }
        break

      case 'tool_start':
        process.stdout.write(
          c(C.gray, `  → ${event.name}`) +
          c(C.dim,  ` ${formatInput(event.input)}`) + '\n'
        )
        break

      case 'tool_end': {
        const ex = event.execution
        if (ex.status === 'success') {
          const preview = ex.result?.content ? truncate(ex.result.content, 80) : ''
          process.stdout.write(c(C.gray, `     ✓ ${preview}`) + '\n')
        } else if (ex.status === 'runtime_failure') {
          process.stdout.write(c(C.yellow, `     ✗ ${truncate(ex.error ?? ex.result?.content ?? 'error', 100)}`) + '\n')
        } else {
          process.stdout.write(c(C.dim, `     ${ex.status}`) + '\n')
        }
        break
      }

      case 'error':
        process.stderr.write(c(C.red, `\nError [${event.failure.kind}]: ${event.failure.message}`) + '\n')
        break

      case 'turn_end':
        if (verbose) {
          const r = event.record
          process.stderr.write(
            c(C.dim, `  [turn ${r.outcome} · ${r.durationMs}ms · ${r.tokenUsage.inputTokens}→${r.tokenUsage.outputTokens} tokens]`) + '\n'
          )
        }
        break

      case 'agent_end':
        if (verbose) {
          const n = event.records.length
          process.stderr.write(c(C.dim, `  [${n} turn${n === 1 ? '' : 's'} total]`) + '\n')
        }
        break
    }
  }
}

function formatInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input)
  const entries = Object.entries(input as Record<string, unknown>)
  return entries
    .map(([k, v]) => `${k}=${truncate(String(v), 40)}`)
    .join(' ')
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, '↵').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

// ── Help / error ──────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
${c(C.bold, 'CodingAgent CLI')}

${c(C.bold, 'Usage:')}
  npx tsx demo/agent/cli.ts <instruction> [options]
  npx tsx demo/agent/cli.ts -i [options]

${c(C.bold, 'Options:')}
  -C, --cwd <path>       Working directory for tools     ${c(C.dim, '(default: .)')}
  -p, --provider <name>  ollama | anthropic               ${c(C.dim, '(default: AGENT_PROVIDER or ollama)')}
  -s, --system <prompt>  Custom system prompt
      --max-turns <n>    Max turns                        ${c(C.dim, '(default: 20)')}
  -i, --interactive      Multi-turn REPL session
  -v, --verbose          Show turn metadata
  -h, --help             Show this help

${c(C.bold, 'Examples:')}
  npx tsx demo/agent/cli.ts "what does this codebase do?" -C ~/my-project
  npx tsx demo/agent/cli.ts "add tests for src/math.ts" -C . -p anthropic
  npx tsx demo/agent/cli.ts -i -C ~/my-project -v
`)
}

function die(msg: string): never {
  process.stderr.write(c(C.red, `Error: ${msg}`) + '\n')
  process.exit(1)
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

interface CliArgs {
  instruction?: string
  cwd:          string
  provider:     string
  system?:      string
  maxTurns:     number
  interactive:  boolean
  verbose:      boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2)
  const result: CliArgs = {
    cwd:         process.cwd(),
    provider:    process.env['AGENT_PROVIDER'] ?? 'ollama',
    maxTurns:    20,
    interactive: false,
    verbose:     false,
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case '-h': case '--help':        showHelp(); process.exit(0); break
      case '-i': case '--interactive': result.interactive = true;   break
      case '-v': case '--verbose':     result.verbose = true;       break
      case '-C': case '--cwd':         result.cwd = path.resolve(args[++i] ?? '.'); break
      case '-p': case '--provider':    result.provider = args[++i] ?? result.provider; break
      case '-s': case '--system':      result.system = args[++i]; break
      case '--max-turns':              result.maxTurns = parseInt(args[++i] ?? '20', 10); break
      default:
        if (a.startsWith('-')) die(`Unknown option: ${a}`)
        if (result.instruction) die('Multiple instructions provided — wrap in quotes.')
        result.instruction = a
    }
  }

  return result
}

// ── Interactive REPL ──────────────────────────────────────────────────────────

async function runInteractive(
  agent: ReturnType<typeof createCodingAgent>,
  handler: (event: AgentEvent) => void,
): Promise<void> {
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: c(C.cyan, 'you> '),
  })

  rl.prompt()

  for await (const line of rl) {
    const input = line.trim()
    if (!input) { rl.prompt(); continue }
    if (input === '/exit' || input === '/quit') break
    if (input === '/clear') { agent.clearSession(); console.log(c(C.dim, '  [session cleared]')); rl.prompt(); continue }
    if (input === '/history') {
      const turns = agent.getExecutionHistory()
      console.log(c(C.dim, `  [${turns.length} turn(s) in history]`))
      rl.prompt(); continue
    }

    process.stdout.write(c(C.dim, 'agent> '))
    await agent.prompt(input, handler)
    rl.prompt()
  }

  rl.close()
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  // Load .env — check cwd first, then the agentic package root.
  loadEnv(args.cwd)
  loadEnv(path.resolve(import.meta.dirname, '../..'))

  if (!args.interactive && !args.instruction) {
    showHelp()
    die('Provide an instruction or use -i for interactive mode.')
  }

  const router = buildRouter(args.provider)
  const tools  = createCodingTools({ cwd: args.cwd })

  const defaultSystem = [
    'You are a coding assistant with access to the filesystem and shell.',
    `Working directory: ${args.cwd}`,
    'Read files before editing them.',
    'Use shell_run to run tests, compile, or verify your changes.',
    'Be concise. Show only relevant output.',
  ].join('\n')

  const agent = createCodingAgent({
    router,
    tools,
    systemPrompt: args.system ?? defaultSystem,
    maxTurns:     args.maxTurns,
  })

  const handler = makeEventHandler(args.verbose)

  console.log(
    c(C.dim, `provider=${args.provider}  cwd=${args.cwd}  max-turns=${args.maxTurns}`) + '\n'
  )

  if (args.interactive) {
    console.log(c(C.dim, 'Interactive session. Type /exit to quit, /clear to reset, /history for turn count.\n'))
    await runInteractive(agent, handler)
  } else {
    await agent.prompt(args.instruction!, handler)
  }
}

main().catch(e => {
  process.stderr.write(c(C.red, `Fatal: ${e instanceof Error ? e.message : String(e)}`) + '\n')
  process.exit(1)
})
