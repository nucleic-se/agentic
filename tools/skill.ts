import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js'

interface SkillEntry {
    name: string
    modulePath: string
    mutates: boolean
    category: 'content' | 'system'
    required: string[]
    optional: string[]
}

interface SkillApi {
    root: string
    readText(path: string): Promise<string>
    writeText(path: string, content: string): Promise<void>
    exists(path: string): Promise<boolean>
    move(from: string, to: string): Promise<void>
    remove(path: string): Promise<void>
    mkdirp(path: string): Promise<void>
    today(): string
}

const require = createRequire(import.meta.url)

function ok(content: string, data?: unknown): ToolCallResult {
    return { ok: true, content, data }
}

function fail(content: string): ToolCallResult {
    return { ok: false, content }
}

function withinRoot(root: string, abs: string): boolean {
    const rel = path.relative(path.resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function resolveRootPath(root: string, relPath: string): string {
    const abs = path.resolve(root, relPath.trim() || '.')
    if (!withinRoot(root, abs)) throw new Error(`Path escapes working root: ${relPath}`)
    return abs
}

function discoverSkills(root: string): SkillEntry[] {
    const skillsRoot = path.join(root, 'skills')
    if (!fs.existsSync(skillsRoot)) return []

    const entries: SkillEntry[] = []
    for (const category of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!category.isDirectory()) continue
        const categoryDir = path.join(skillsRoot, category.name)
        for (const skill of fs.readdirSync(categoryDir, { withFileTypes: true })) {
            if (!skill.isDirectory()) continue
            const modulePath = path.join(categoryDir, skill.name, 'index.js')
            if (!fs.existsSync(modulePath)) continue
            let mutates = true
            let category: 'content' | 'system' = 'content'
            let required: string[] = []
            let optional: string[] = []
            try {
                const resolved = require.resolve(modulePath)
                delete require.cache[resolved]
                const loaded = require(resolved)
                const meta = loaded?.meta ?? loaded?.default?.meta
                if (meta && typeof meta.mutates === 'boolean') {
                    mutates = meta.mutates
                }
                if (meta && (meta.category === 'content' || meta.category === 'system')) {
                    category = meta.category
                }
                if (meta && Array.isArray(meta.required)) {
                    required = meta.required.map(String)
                }
                if (meta && Array.isArray(meta.optional)) {
                    optional = meta.optional.map(String)
                }
            } catch {
                // Fall back to mutating=true so write budgets remain conservative.
            }
            entries.push({ name: skill.name, modulePath, mutates, category, required, optional })
        }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function skillSignature(skill: SkillEntry): string {
    const required = skill.required
    const optional = skill.optional.map(name => `${name}?`)
    const args = [...required, ...optional].join(', ')
    return `${skill.name}(${args})`
}

function makeApi(root: string): SkillApi {
    return {
        root,
        async readText(relPath: string): Promise<string> {
            return fs.readFileSync(resolveRootPath(root, relPath), 'utf8')
        },
        async writeText(relPath: string, content: string): Promise<void> {
            const abs = resolveRootPath(root, relPath)
            fs.mkdirSync(path.dirname(abs), { recursive: true })
            fs.writeFileSync(abs, content, 'utf8')
        },
        async exists(relPath: string): Promise<boolean> {
            return fs.existsSync(resolveRootPath(root, relPath))
        },
        async move(from: string, to: string): Promise<void> {
            const absFrom = resolveRootPath(root, from)
            const absTo = resolveRootPath(root, to)
            fs.mkdirSync(path.dirname(absTo), { recursive: true })
            fs.renameSync(absFrom, absTo)
        },
        async remove(relPath: string): Promise<void> {
            fs.rmSync(resolveRootPath(root, relPath), { recursive: false, force: false })
        },
        async mkdirp(relPath: string): Promise<void> {
            fs.mkdirSync(resolveRootPath(root, relPath), { recursive: true })
        },
        today(): string {
            return new Date().toISOString().slice(0, 10)
        },
    }
}

export class SkillToolRuntime implements IToolRuntime {
    private readonly skills: SkillEntry[]
    private readonly api: SkillApi

    constructor(private readonly root: string) {
        this.skills = discoverSkills(root)
        this.api = makeApi(root)
    }

    tools(): ToolDefinition[] {
        const available = this.skills.map(skillSignature).join('; ') || '(none)'
        return [{
            name: 'skill_run',
            description: `Run an executable grove skill by name. Prefer this when a procedure references → skill:. Available skills and inputs: ${available}`,
            parameters: {
                type: 'object',
                required: ['skill', 'input'],
                properties: {
                    skill: { type: 'string', description: 'Skill name exactly as referenced in the grove.' },
                    input: {
                        type: 'object',
                        description: 'Skill inputs as defined by that skill.',
                        additionalProperties: true,
                    },
                },
            },
        }]
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        if (name !== 'skill_run') return fail(`Unknown tool: ${name}`)
        const skillName = String(args['skill'] ?? '').trim()
        const input = (args['input'] ?? {}) as Record<string, unknown>
        if (!skillName) return fail('skill is required')

        const entry = this.skills.find(skill => skill.name === skillName)
        if (!entry) return fail(`Executable skill not found: ${skillName}`)

        try {
            const resolved = require.resolve(entry.modulePath)
            delete require.cache[resolved]
            const loaded = require(resolved)
            const run = loaded?.run ?? loaded?.default?.run ?? loaded?.default
            if (typeof run !== 'function') return fail(`Skill ${skillName} does not export a run() function`)
            const result = await run(input, this.api)
            if (typeof result === 'string') return ok(result)
            if (result && typeof result === 'object') {
                const content = typeof result.content === 'string'
                    ? result.content
                    : JSON.stringify(result)
                return ok(content, result)
            }
            return ok(`Skill ${skillName} completed.`)
        } catch (err) {
            return fail(`Skill ${skillName} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    mutatingToolNames(): ReadonlySet<string> {
        return new Set(['skill_run'])
    }

    isMutatingCall(name: string, args: Record<string, unknown>): boolean {
        if (name !== 'skill_run') return false
        const skillName = String(args['skill'] ?? '').trim()
        const entry = this.skills.find(skill => skill.name === skillName)
        return entry?.mutates ?? true
    }

    mutationCategory(name: string, args: Record<string, unknown>): 'content' | 'system' | null {
        if (name !== 'skill_run') return null
        const skillName = String(args['skill'] ?? '').trim()
        const entry = this.skills.find(skill => skill.name === skillName)
        return entry?.mutates ? entry.category : null
    }

    describeSkill(name: string): string | null {
        const entry = this.skills.find(skill => skill.name === name)
        return entry ? skillSignature(entry) : null
    }
}
