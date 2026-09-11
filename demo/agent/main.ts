#!/usr/bin/env node
import { loadSkills } from '../../tools/skills.js';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { createDefaultAgent } from '../../runtime/harness/preset.js';
import { startWebUi } from '../../runtime/harness/ui/web.js';
import { startTerminalUi } from '../../runtime/harness/ui/terminal.js';
import { providerOptions } from './provider-options.js';
import { selectProvider } from '../../providers/select.js';

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => { const i = args.indexOf(name); if (i === -1) return fallback; if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`Missing value for ${name}`); return args[i+1]; };
if (args.includes('--help')) {
    console.log('Agentic reference agent\n\n--workspace PATH   Tool working directory (default cwd)\n--data PATH        Local database/token directory (default depends on provider/auth)\n--model NAME       Selected provider model (default OpenAI subscription: gpt-6-astra)\n--web              Start browser UI\n--host ADDRESS     Bind address (default 127.0.0.1; use 0.0.0.0 for Wi-Fi)\n--port NUMBER      Web port (default 4317)\n--terminal         Attach terminal UI too\n--planning         Use planning loop\n--memory           Enable workspace notes and explicit recall\n--skills PATH      Load explicit skill directory/catalog (optional)\n\nBrowser login token is stored in DATA/web-token; subscription credentials stay server-side.');
    console.log('\nProvider access:\n--provider NAME    openai (default) or anthropic\n--auth MODE        subscription (default) or api-key; never auto-falls back\n--model NAME       Explicit model required for API-key authentication\n--context-tokens N Explicit working budget required for API providers\n--auth-file PATH   Agentic Anthropic credential store, or existing Codex auth file\n--login            Sign in to the selected subscription; no model call\n\nAPI keys: AGENTIC_OPENAI_API_KEY / OPENAI_API_KEY or AGENTIC_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY.');
    process.exit(0);
}
const selection = providerOptions(args);
const anthropicAuth = async () => {
    const [{ createAnthropicSubscriptionAuth }, { FileCredentialStore }] = await Promise.all([
        import('../../providers/anthropic-auth.js'),
        import('../../providers/file-credentials.js'),
    ]);
    return createAnthropicSubscriptionAuth(new FileCredentialStore(
        selection.authFilePath ?? join(homedir(), '.agentic', 'anthropic-auth.json'),
    ));
};
if (selection.login) {
    if (selection.provider === 'openai') {
        if (selection.authFilePath) throw new Error('Use CODEX_HOME to select the Codex login directory, then pass its auth.json with --auth-file');
        const { spawn } = await import('node:child_process');
        const exitCode = await new Promise<number>((resolve, reject) => {
            const login = spawn('codex', ['login'], { stdio: 'inherit' });
            login.once('error', reject);
            login.once('exit', code => resolve(code ?? 1));
        });
        process.exit(exitCode);
    }
    const { createInterface } = await import('node:readline/promises');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Login cancelled'));
    terminal.once('SIGINT', cancel);
    try {
        const auth = await anthropicAuth();
        await auth.login({
            signal: controller.signal,
            notify(event) {
                if (event.type === 'auth_url') console.log(`${event.instructions ?? 'Open this URL to sign in:'}\n${event.url}`);
                else if (event.type === 'device_code') console.log(`${event.verificationUri}\nCode: ${event.userCode}`);
                else console.log(event.message);
            },
            prompt: prompt => terminal.question(`${prompt.message} `, { signal: prompt.signal ?? controller.signal }),
        });
        console.log('Anthropic subscription login saved.');
    } finally {
        terminal.close();
    }
    process.exit(0);
}
const workspace = resolve(value('--workspace', process.cwd()));
const legacyOpenAISubscription = selection.provider === 'openai' && selection.auth === 'subscription';
const defaultData = legacyOpenAISubscription ? join(homedir(), '.agentic') : join(homedir(), '.agentic', `${selection.provider}-${selection.auth}`);
const data = resolve(value('--data', defaultData));
await mkdir(data, { recursive: true, mode: 0o700 });
const model = selection.model!;
const provider = legacyOpenAISubscription ? undefined : selection.auth === 'api-key'
    ? await selectProvider({ provider: selection.provider, auth: 'api-key', model })
    : await selectProvider({ provider: 'anthropic', auth: 'subscription', model, credentials: (await anthropicAuth()).credentials });
const client = await createDefaultAgent({ workspace,
    ...(legacyOpenAISubscription ? { model, authFilePath: selection.authFilePath } : { provider }),
    tokenBudget: selection.tokenBudget,
    database: join(data, 'sessions.sqlite'), planning: args.includes('--planning'),
    memoryDatabase: args.includes('--memory') ? join(data, 'memory.sqlite') : undefined,
    skills: args.includes('--skills') ? await loadSkills({ directories: [resolve(value('--skills', ''))] }) : undefined });
const cleanups: Array<() => void | Promise<void>> = [];
try {
    if (args.includes('--web')) {
        const tokenPath = join(data, 'web-token');
        let token: string;
        try { token = (await readFile(tokenPath, 'utf8')).trim(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; token = randomBytes(24).toString('base64url'); await writeFile(tokenPath, token+'\n', { flag: 'wx', mode: 0o600 }); }
        await chmod(tokenPath, 0o600);
        const host = value('--host', '127.0.0.1');
        const port = Number(value('--port', '4317'));
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
        const ui = await startWebUi(client, { token, host, port }); cleanups.push(() => ui.close());
        console.log(`Agentic web UI: http://127.0.0.1:${port}\nLogin token file: ${tokenPath}\nWorkspace: ${workspace}\nModel: ${model}`);
        if (host === '0.0.0.0') {
            for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) {
                if (address.family === 'IPv4' && !address.internal) console.log(`Network address: http://${address.address}:${port}`);
            }
            console.log('Wi-Fi mode: use a trusted local network; HTTP is not encrypted. Do not port-forward this server.');
        }
    }
    if (!args.includes('--web') || args.includes('--terminal')) cleanups.push(await startTerminalUi(client, { workspace }));
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return; shuttingDown = true;
        for (const cleanup of cleanups.reverse()) await cleanup();
        await client.close();
    };
    process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
} catch (error) { for (const cleanup of cleanups.reverse()) await cleanup(); await client.close(); throw error; }
