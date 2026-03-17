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
 *   -m, --model <model>       Override balanced model (the main chat model)
 *   -s, --system <prompt>     Override system prompt
 *       --max-turns <n>       Turn limit                               (default: 20)
 *   -i, --interactive         Multi-turn interactive session
 *   -v, --verbose             Show raw event stream (tool results, turn metadata)
 *   -t, --trace               Dump hierarchical span trace after run
 *   -d, --debug-log           Write full debug log (all turns, tool I/O) to .agent-logs/
 *   -a, --auto-stop           Skip follow-up LLM call when all tools succeed
 *   -h, --help                Show this help
 */

import * as fs       from 'node:fs'
import * as path     from 'node:path'
import * as readline from 'node:readline'
import { createCodingAgent, createCodingTools, createCodingRegistry } from './index.js'
import { TrustTierToolPolicy }                  from '../../runtime/ToolPolicy.js'
import { OllamaProvider, AnthropicProvider, OLLAMA_CLOUD_MODEL_DEFAULTS } from '../../providers/index.js'
import { InMemorySpanTracer }                  from '../../runtime/InMemorySpanTracer.js'
import type { ILLMProvider, ModelTier } from '../../contracts/llm.js'
import type { AgentEvent, TurnRecord } from '../../contracts/agent.js'
import type { IModelRouter } from '../../contracts/llm.js'

// ── ANSI colours ──────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  italic: '\x1b[3m',
  dim:    '\x1b[2m',
  underline: '\x1b[4m',
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

// ── Markdown rendering ───────────────────────────────────────────────────────

function renderInlineMarkdown(text: string): string {
  let rendered = text

  rendered = rendered.replace(/`([^`]+)`/g, (_, code: string) => c(C.cyan, code))
  rendered = rendered.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
    `${c(C.underline, label)} ${c(C.gray, `<${url}>`)}`,
  )
  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => c(C.bold, bold))
  rendered = rendered.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, italic: string) => c(C.italic, italic))

  return rendered
}

function renderMarkdownToAnsi(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const rendered: string[] = []
  let inCodeBlock = false
  let codeFence = ''

  for (const line of lines) {
    const fenceMatch = line.match(/^```(\S*)\s*$/)
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeFence = fenceMatch[1] ?? ''
        rendered.push(c(C.dim, codeFence ? `[${codeFence}]` : '[code]'))
      } else {
        inCodeBlock = false
        codeFence = ''
      }
      continue
    }

    if (inCodeBlock) {
      rendered.push(c(C.cyan, line))
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      rendered.push(c(C.bold, renderInlineMarkdown(headingMatch[2].trim()).toUpperCase()))
      continue
    }

    const quoteMatch = line.match(/^>\s?(.*)$/)
    if (quoteMatch) {
      rendered.push(c(C.gray, `│ ${renderInlineMarkdown(quoteMatch[1])}`))
      continue
    }

    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (bulletMatch) {
      rendered.push(`${bulletMatch[1]}• ${renderInlineMarkdown(bulletMatch[2])}`)
      continue
    }

    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/)
    if (orderedMatch) {
      rendered.push(`${orderedMatch[1]}${orderedMatch[2]}. ${renderInlineMarkdown(orderedMatch[3])}`)
      continue
    }

    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      rendered.push(c(C.dim, '────────────────────'))
      continue
    }

    rendered.push(renderInlineMarkdown(line))
  }

  return rendered.join('\n')
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

function buildRouter(providerName: string, modelOverride?: string): IModelRouter {
  const fastModel     = process.env['AGENT_FAST_MODEL']
  const balancedModel = modelOverride ?? process.env['AGENT_BALANCED_MODEL']
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
  let streamedContent = false
  let bufferedMarkdown = ''
  return (event) => {
    switch (event.type) {
      case 'message_delta':
        streamedContent = true
        bufferedMarkdown += event.text
        break

      case 'message_end':
        if (!streamedContent && event.message.content) {
          bufferedMarkdown = event.message.content
        }
        if (bufferedMarkdown) {
          process.stdout.write(renderMarkdownToAnsi(bufferedMarkdown))
          process.stdout.write('\n')
        }
        streamedContent = false
        bufferedMarkdown = ''
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
  -m, --model <model>    Override balanced (chat) model   ${c(C.dim, '(e.g. glm-5:cloud, claude-sonnet-4-6)')}
  -s, --system <prompt>  Custom system prompt
      --max-turns <n>    Max turns                        ${c(C.dim, '(default: 20)')}
  -i, --interactive      Multi-turn REPL session
  -v, --verbose          Show turn metadata
  -t, --trace            Dump span trace after run
  -d, --debug-log        Write full debug log to .agent-logs/
  -a, --auto-stop        Skip follow-up LLM call when all tools succeed
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
  model?:       string
  system?:      string
  maxTurns:     number
  interactive:  boolean
  verbose:      boolean
  trace:        boolean
  debugLog:     boolean
  autoStop:     boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2)
  const result: CliArgs = {
    cwd:         process.cwd(),
    provider:    process.env['AGENT_PROVIDER'] ?? 'ollama',
    maxTurns:    20,
    interactive: false,
    verbose:     false,
    trace:       false,
    debugLog:    false,
    autoStop:    false,
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case '-h': case '--help':        showHelp(); process.exit(0); break
      case '-i': case '--interactive': result.interactive = true;   break
      case '-v': case '--verbose':     result.verbose = true;       break
      case '-t': case '--trace':       result.trace = true;         break
      case '-d': case '--debug-log':  result.debugLog = true;      break
      case '-a': case '--auto-stop': result.autoStop = true;      break
      case '-C': case '--cwd':         result.cwd = path.resolve(args[++i] ?? '.'); break
      case '-p': case '--provider':    result.provider = args[++i] ?? result.provider; break
      case '-m': case '--model':       result.model = args[++i]; break
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
  // Load .env files. Project-level overrides package-level — loadEnv() only
  // sets keys not already in process.env, so load project .env first.
  const pkgRoot = path.resolve(import.meta.dirname, '../..')
  const cwdArgIdx = process.argv.findIndex(a => a === '-C' || a === '--cwd')
  if (cwdArgIdx !== -1 && process.argv[cwdArgIdx + 1]) {
    loadEnv(path.resolve(process.argv[cwdArgIdx + 1]))  // project .env first (overrides)
  }
  loadEnv(pkgRoot)  // package .env second (fallback defaults)

  const args = parseArgs(process.argv)

  // Load project .env now that cwd is fully resolved (covers the no-C case).
  loadEnv(args.cwd)

  if (!args.interactive && !args.instruction) {
    showHelp()
    die('Provide an instruction or use -i for interactive mode.')
  }

  // Validate inputs.
  if (!fs.existsSync(args.cwd) || !fs.statSync(args.cwd).isDirectory()) {
    die(`Working directory does not exist: ${args.cwd}`)
  }
  const validProviders = ['ollama', 'anthropic']
  if (!validProviders.includes(args.provider)) {
    die(`Unknown provider "${args.provider}". Use: ${validProviders.join(', ')}`)
  }

  const router   = buildRouter(args.provider, args.model)
  const tools    = createCodingTools({ cwd: args.cwd })
  const registry = createCodingRegistry(tools)
  const policy   = new TrustTierToolPolicy(registry)
  const tracer   = args.trace ? new InMemorySpanTracer() : undefined

  const defaultSystem = [
    'You are a coding assistant with access to the filesystem and shell.',
    `Working directory: ${args.cwd}`,
    'Read files before editing them.',
    'When multiple independent actions are needed, call ALL tools in a single response instead of one at a time. For example, to read 3 files, return 3 fs_read tool calls in one message.',
    'Use shell_run for exploration, testing, compilation, and verification.',
    'Each shell call is a fresh subprocess — no env vars, aliases, or working directory persist between calls. Use the cwd parameter instead of cd.',
    'stdin is not available. Never run interactive commands (npm init without -y, python REPL, editors, git rebase -i) — they will hang until timeout.',
    'Background processes (&) return immediately with no output from the background process. Avoid them.',
    'Output is capped at 64 KB. For commands that produce large output, pipe through head, tail, or grep.',
    'Prefer targeted commands: rg <pattern> for content search, rg --files for listing files. Avoid broad scans.',
    'Chain related commands with && or ; to reduce round trips.',
    'Never run destructive commands (rm -rf, git reset --hard, git push --force) unless the user explicitly asks.',
    'After tool calls complete, respond with the answer directly. Do not narrate which tools you called.',
    'Respond in Markdown. Use fenced code blocks for code and concise Markdown structure for explanations.',
    'Be concise. Show only relevant output.',
  ].join('\n')

  const agent = createCodingAgent({
    router,
    tools,
    registry,
    policy,
    tracer,
    systemPrompt: args.system ?? defaultSystem,
    maxTurns:     args.maxTurns,
    autoStop:     args.autoStop,
  })

  const handler = makeEventHandler(args.verbose)

  const banner = [`provider=${args.provider}`, `cwd=${args.cwd}`, `max-turns=${args.maxTurns}`]
  if (args.model) banner.push(`model=${args.model}`)
  console.log(c(C.dim, banner.join('  ')) + '\n')

  if (args.interactive) {
    console.log(c(C.dim, 'Interactive session. Type /exit to quit, /clear to reset, /history for turn count.\n'))
    await runInteractive(agent, handler)
  } else {
    await agent.prompt(args.instruction!, handler)
  }

  // Phase D: dump spans after run.
  if (tracer) {
    const spans = tracer.export()
    if (spans.length > 0) {
      process.stderr.write('\n' + c(C.bold, 'Trace spans:') + '\n')
      for (const s of spans) {
        const dur = s.endTime ? `${s.endTime - s.startTime}ms` : 'open'
        const indent = s.parentSpanId ? '  ' : ''
        const icon = s.status === 'ok' ? '✓' : s.status === 'error' ? '✗' : '○'
        process.stderr.write(
          c(C.dim, `${indent}${icon} ${s.type}  ${dur}`) +
          (s.error ? c(C.yellow, `  ${s.error.slice(0, 80)}`) : '') + '\n'
        )
      }
    }
  }

  // Debug log: write full turn records + trace spans to disk.
  if (args.debugLog) {
    const logDir = path.join(args.cwd, '.agent-logs')
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const logFile = path.join(logDir, `run-${ts}.json`)
    const records = agent.getExecutionHistory()
    const payload = {
      timestamp: new Date().toISOString(),
      provider:  args.provider,
      cwd:       args.cwd,
      system:    args.system ?? '(default)',
      maxTurns:  args.maxTurns,
      instruction: args.instruction ?? '(interactive)',
      turns:     records,
      spans:     tracer?.export() ?? [],
    }
    fs.writeFileSync(logFile, JSON.stringify(payload, null, 2))
    process.stderr.write(c(C.dim, `\nDebug log: ${logFile}`) + '\n')
  }
}

main().catch(e => {
  process.stderr.write(c(C.red, `Fatal: ${e instanceof Error ? e.message : String(e)}`) + '\n')
  process.exit(1)
})
