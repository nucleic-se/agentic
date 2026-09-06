import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Exercise the shipped worker entrypoint. npm test builds first to prevent stale artifacts.
import { SearchToolRuntime } from '../dist/tools/search.js'
import { FsToolRuntime } from '../dist/tools/fs.js'
import { codingToolRuntime } from '../dist/runtime/harness/defaults.js'
import { composeAgentContext } from '../dist/runtime/ContextPipeline.js'
let base: string, root: string
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'agentic-io-test-')); root = join(base, 'root'); await mkdir(root) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

it('returns complete coding read pages that survive context presentation unchanged', async () => {
    const source = Array.from({ length: 180 }, (_, index) => `const value${index} = "${'🌱quoted '.repeat(7)}";`)
    await writeFile(join(root, 'source.ts'), source.join('\n'))
    const runtime = codingToolRuntime(root)
    const collected: string[] = []
    let offset = 1
    for (let page = 0; page < source.length; page++) {
        const result = await runtime.call('fs_read', { path: 'source.ts', offset, limit: 1000 })
        expect(result.ok).toBe(true)
        expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(4000)
        const data = result.data as { linesReturned: number; nextOffset?: number }
        expect(data.linesReturned).toBeGreaterThan(0)
        collected.push(...result.content.split('\n').slice(0, data.linesReturned).map(line => line.replace(/^\d+: /, '')))
        const context = await composeAgentContext({ tokenBudget: 16000, messages: [
            { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'fs_read', args: { path: 'source.ts', offset } }] },
            { role: 'tool_result', toolCallId: 'read', toolName: 'fs_read', content: result.content },
        ] }, { maxToolResultCharacters: 4000, referenceToolResult: () => 'read_tool_result for original' })
        expect(context.messages[1].content).toBe(result.content)
        if (data.nextOffset === undefined) break
        expect(data.nextOffset).toBe(offset + data.linesReturned)
        offset = data.nextOffset
    }
    expect(collected).toEqual(source)
})

it('validates configurable text page limits and keeps raw filesystem defaults independent', async () => {
    for (const textPageBytes of [0, 255, 262145, 4000.5, NaN, Infinity])
        expect(() => new FsToolRuntime(root, { textPageBytes })).toThrow(RangeError)
    await writeFile(join(root, 'long'), 'x'.repeat(4100))
    const bounded = new FsToolRuntime(root, { textPageBytes: 4000 })
    expect(await bounded.call('fs_read', { path: 'long' })).toMatchObject({ ok: false })
    const ordinary = new FsToolRuntime(root)
    expect(await ordinary.call('fs_read', { path: 'long' })).toMatchObject({ ok: true })
    const tools = bounded.tools()
    tools[0].description = 'changed'
    expect(bounded.tools()[0].description).toContain('4000')
    expect(ordinary.tools()[0].description).toContain('262144')
})

it('confines the public search primitive against symlink directories and parent paths', async () => {
    const outside = join(base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'sentinel')
    await symlink(outside, join(root, 'linked'))
    const runtime = new SearchToolRuntime(root)
    for (const path of ['linked', '../outside']) {
        const result = await runtime.call('search_grep', { path, pattern: 'sentinel' })
        expect(result.ok).toBe(false); expect(result.content).not.toContain('secret:')
    }
    await writeFile(join(root, 'local'), 'sentinel')
    expect((await runtime.call('search_grep', { pattern: 'sentinel' })).content).toContain('local:1: sentinel')
})

it('interrupts pathological regex work while keeping the host responsive', async () => {
    await writeFile(join(root, 'input'), 'a'.repeat(40) + '!')
    let heartbeat = false, started = false
    const controller = new AbortController()
    const result = await codingToolRuntime(root).call('search_grep', { pattern: '^(a+)+$', path: '.' }, {
        signal: controller.signal,
        onUpdate() {
            started = true
            // The worker has entered its search handler; cancel ongoing work, not module startup.
            setTimeout(() => { heartbeat = true; controller.abort() }, 50)
        },
    })
    expect(result).toMatchObject({ ok: false, errorKind: 'cancelled' })
    expect(started).toBe(true)
    expect(heartbeat).toBe(true)
    expect((await new SearchToolRuntime(root).call('search_find', { pattern: '*' })).ok).toBe(true)
}, 3000)

it('bounds count mode as well as content mode', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(root, String(i)), 'hit')
    const result = await new SearchToolRuntime(root).call('search_grep', { pattern: 'hit', output: 'count', max_results: 2 })
    expect(result.data).toMatchObject({ fileCount: 2 })
})

it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', () => {
    expect(spawnSync('mkfifo', [join(root, 'pipe')]).status).toBe(0)
    // A subprocess timeout contains a regression in blocking open/read.
    const script = `import { FsToolRuntime } from ${JSON.stringify(new URL('../dist/tools/fs.js', import.meta.url).href)}; console.log(JSON.stringify(await new FsToolRuntime(process.argv[1]).call('fs_read',{path:'pipe'})))`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { timeout: 2000, encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, content: 'Not a regular file' })
})

it('reads a small range from a large file and provides a line continuation', async () => {
    await writeFile(join(root, 'file'), 'first\nsecond\n' + 'x'.repeat(300000))
    const runtime = new FsToolRuntime(root)
    const first = await runtime.call('fs_read', { path: 'file', offset: 1, limit: 1 })
    expect(first).toMatchObject({ ok: true, content: '1: first\n[truncated; continue with offset: 2]', data: { nextOffset: 2, truncated: true } })
    expect(first.data).not.toHaveProperty('totalLines')
    expect(await runtime.call('fs_read', { path: 'file', offset: 2, limit: 1 })).toMatchObject({ ok: true, content: '2: second\n[truncated; continue with offset: 3]' })
    expect(await runtime.call('fs_read', { path: 'file', offset: 3, limit: 1 })).toMatchObject({ ok: false })
})

it('caps range output at line boundaries and continues without losing evidence', async () => {
    const line = 'a'.repeat(100000)
    await writeFile(join(root, 'file'), [line, line, 'last'].join('\n'))
    const runtime = new FsToolRuntime(root)
    const all = await runtime.call('fs_read', { path: 'file', offset: 1 })
    expect(all).toMatchObject({ ok: true, data: { totalLines: 3, truncated: false } })
    await writeFile(join(root, 'file'), [line, line, line, 'last'].join('\n'))
    const first = await runtime.call('fs_read', { path: 'file', offset: 1 })
    expect(first).toMatchObject({ ok: true, data: { nextOffset: 3, linesReturned: 2, truncated: true } })
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(262144)
    expect(await runtime.call('fs_read', { path: 'file', offset: 3 })).toMatchObject({ ok: true, content: `3: ${line}\n4: last`, data: { totalLines: 4, truncated: false } })
})

it('preserves UTF-8 at read boundaries and supports cancelling a range scan', async () => {
    const text = 'a'.repeat(8191) + '🙂\ntail'
    await writeFile(join(root, 'file'), text)
    const runtime = new FsToolRuntime(root)
    expect((await runtime.call('fs_read', { path: 'file', offset: 1 })).content).toBe(`1: ${text.replace('\n', '\n2: ')}`)
    await writeFile(join(root, 'file'), 'a'.repeat(8_000_000))
    expect(await runtime.call('fs_read', { path: 'file', offset: 100 }, { signal: AbortSignal.timeout(1) })).toMatchObject({ ok: false, errorKind: 'cancelled' })
})

it('rejects malformed range arguments and ambiguous base64 line ranges', async () => {
    const runtime = new FsToolRuntime(root)
    for (const args of [{ offset: 0 }, { limit: -1 }, { offset: 1, encoding: 'base64' }])
        expect((await runtime.call('fs_read', { path: 'file', ...args })).ok).toBe(false)
})

it('terminates search at its default deadline without a caller signal', async () => {
    await writeFile(join(root, 'input'), 'a'.repeat(40) + '!')
    vi.useFakeTimers()
    try {
        const result = new SearchToolRuntime(root).call('search_grep', { pattern: '^(a+)+$' })
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await result).toMatchObject({ ok: false, errorKind: 'timeout' })
    } finally { vi.useRealTimers() }
})

it('runs the search worker from a module-eval parent process', async () => {
    await writeFile(join(root, 'local'), 'hit')
    const script = `import { SearchToolRuntime } from ${JSON.stringify(new URL('../dist/tools/search.js', import.meta.url).href)}; console.log(JSON.stringify(await new SearchToolRuntime(process.argv[1]).call('search_grep',{pattern:'hit'})))`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { timeout: 2000, encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true })
})


it('pages default UTF-8 reads and reconstructs every line through continuation offsets', async () => {
    const lines = Array.from({ length: 451 }, (_, i) => `line-${i + 1}-🙂`)
    await writeFile(join(root, 'paged'), lines.join('\n'))
    const runtime = codingToolRuntime(root)
    const restored: string[] = []
    let offset: number | undefined
    for (let page = 0; page < 3; page++) {
        const result = await runtime.call('fs_read', { path: 'paged', ...(offset ? { offset } : {}) })
        expect(result.ok).toBe(true)
        const data = result.data as { linesReturned: number; truncated: boolean; nextOffset?: number }
        expect(data.linesReturned).toBe(page < 2 ? 200 : 51)
        restored.push(...result.content.split('\n').filter(line => !line.startsWith('[truncated;')).map(line => line.replace(/^\d+: /, '')))
        expect(data.truncated).toBe(page < 2)
        offset = data.nextOffset
    }
    expect(offset).toBeUndefined()
    expect(restored).toEqual(lines)
    const largerRange = await runtime.call('fs_read', { path: 'paged', limit: 500 })
    expect(largerRange).toMatchObject({ ok: true, data: { truncated: true } })
    expect(Buffer.byteLength(largerRange.content)).toBeLessThanOrEqual(4000)
    expect(await new FsToolRuntime(root).call('fs_read', { path: 'paged', limit: 500 })).toMatchObject({ ok: true, data: { linesReturned: 451, truncated: false } })
})

it('keeps base64 reads exact and independent of the default text page size', async () => {
    const bytes = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256))
    await writeFile(join(root, 'binary'), bytes)
    expect(await new FsToolRuntime(root).call('fs_read', { path: 'binary', encoding: 'base64' })).toMatchObject({ ok: true, content: bytes.toString('base64') })
})


it('searches an explicit file in every output mode, respecting include filters and confinement', async () => {
    await writeFile(join(root, 'selected.ts'), 'before\nhit\nhit\nafter')
    await writeFile(join(root, 'other.ts'), 'hit')
    const runtime = new SearchToolRuntime(root)
    expect(await runtime.call('search_grep', { path: 'selected.ts', pattern: 'hit', context_lines: 1 })).toMatchObject({ ok: true, data: { count: 2 } })
    expect(await runtime.call('search_grep', { path: 'selected.ts', pattern: 'hit', output: 'count' })).toMatchObject({ ok: true, data: { fileCount: 1, totalMatches: 2 } })
    expect(await runtime.call('search_grep', { path: 'selected.ts', pattern: 'hit', output: 'files_only', include: '*.ts' })).toMatchObject({ ok: true, content: 'selected.ts' })
    expect(await runtime.call('search_grep', { path: 'selected.ts', pattern: 'hit', include: '*.md' })).toMatchObject({ ok: true, content: 'No matches found.' })
    expect(await runtime.call('search_find', { path: 'selected.ts', pattern: '*.ts' })).toMatchObject({ ok: true, content: 'selected.ts' })
    await writeFile(join(base, 'outside.ts'), 'hit')
    await symlink(join(base, 'outside.ts'), join(root, 'escape.ts'))
    expect((await runtime.call('search_grep', { path: 'escape.ts', pattern: 'hit' })).ok).toBe(false)
})
