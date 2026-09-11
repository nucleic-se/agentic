import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.each([
    { provider: 'openai', auth: 'subscription', model: 'gpt-6-astra', supplied: false, defaults: true },
    { provider: 'openai', auth: 'subscription', model: 'gpt-6-astra', supplied: false },
    { provider: 'openai', auth: 'api-key', model: 'test-openai-model', supplied: true },
    { provider: 'anthropic', auth: 'api-key', model: 'claude-sonnet-4-6', supplied: true },
    { provider: 'anthropic', auth: 'subscription', model: 'claude-sonnet-4-6', supplied: true },
])('wires the real $provider/$auth selector into the CLI preset without a model call', async choice => {
    const data = await mkdtemp(join(tmpdir(), 'provider-cli-'));
    const preset = `export async function createDefaultAgent(options) {
        console.log('CLI_RESULT:' + JSON.stringify({
            supplied: !!options.provider, model: options.model,
            identity: options.provider?.configurationIdentity,
            budget: options.tokenBudget, database: options.database
        }));
        return {};
    }`;
    const terminal = 'export async function startTerminalUi() { return () => {}; }';
    const hooks = `export async function resolve(specifier, context, nextResolve) {
        if (specifier.endsWith('/runtime/harness/preset.js')) return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(preset))}, shortCircuit: true };
        if (specifier.endsWith('/runtime/harness/ui/terminal.js')) return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(terminal))}, shortCircuit: true };
        return nextResolve(specifier, context);
    }`;
    const register = `import { register } from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hooks))}, import.meta.url); globalThis.fetch = () => { throw new Error('Unexpected network request'); };`;
    try {
        const output = execFileSync(process.execPath, [
            '--import', 'data:text/javascript,' + encodeURIComponent(register),
            join(process.cwd(), 'dist/demo/agent/main.js'),
            ...('defaults' in choice ? [] : ['--provider', choice.provider, '--auth', choice.auth, '--model', choice.model]),
            '--context-tokens', '32000', '--data', data, '--workspace', data,
        ], {
            encoding: 'utf8', timeout: 15000,
            env: { ...process.env, AGENTIC_OPENAI_API_KEY: 'fixture-openai', AGENTIC_ANTHROPIC_API_KEY: 'fixture-anthropic' },
        });
        const line = output.split('\n').find(line => line.startsWith('CLI_RESULT:'))!;
        const result = JSON.parse(line.slice('CLI_RESULT:'.length));
        expect(result).toMatchObject({ supplied: choice.supplied, budget: 32000, database: join(data, 'sessions.sqlite') });
        if (choice.supplied) expect(result.identity).toEqual(expect.any(String));
        else expect(result.model).toBe(choice.model);
        expect(output).not.toContain('fixture-openai');
        expect(output).not.toContain('fixture-anthropic');
    } finally {
        await rm(data, { recursive: true, force: true });
    }
});
