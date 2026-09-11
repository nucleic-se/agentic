import { expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

it('imports the empty host without optional packages and excludes addon modules from its static graph', async () => {
    const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
    const root = await mkdtemp(join(tmpdir(), 'agentic-core-consumer-'));
    try {
        await cp(dist, join(root, 'dist'), { recursive: true });
        await writeFile(join(root, 'package.json'), '{"type":"module"}');
        const entry = join(root, 'dist/runtime/harness/core.js');
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const core = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log([core.createHarness, core.inspectHarness, core.inspectOperation].map(value => typeof value).join(','))`], { cwd: root, encoding: 'utf8' });
        expect(output.trim()).toBe('function,function,function');
        const seen = new Set<string>();
        const visit = async (file: string): Promise<void> => {
            if (seen.has(file)) return;
            seen.add(file);
            const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            for (const statement of source.statements) {
                if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
                const name = statement.moduleSpecifier.text;
                if (name.startsWith('.')) await visit(resolve(dirname(file), name));
                else expect(name.startsWith('node:')).toBe(true);
            }
        };
        await visit(entry);
        for (const file of seen) expect(file).not.toMatch(/\/(tools|providers|ui)\/|\/(coding|preset|defaults)\.js$/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
