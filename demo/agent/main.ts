#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { createDefaultAgent } from '../../runtime/harness/preset.js';
import { startWebUi } from '../../runtime/harness/ui/web.js';
import { startTerminalUi } from '../../runtime/harness/ui/terminal.js';

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => { const i = args.indexOf(name); if (i === -1) return fallback; if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`Missing value for ${name}`); return args[i+1]; };
if (args.includes('--help')) {
    console.log('Agentic reference agent\n\n--workspace PATH   Tool working directory (default cwd)\n--data PATH        Local database/token directory (default ~/.agentic)\n--model NAME       Codex subscription model (default gpt-6-astra)\n--web              Start browser UI\n--host ADDRESS     Bind address (default 127.0.0.1; use 0.0.0.0 for Wi-Fi)\n--port NUMBER      Web port (default 4317)\n--terminal         Attach terminal UI too\n--planning         Use planning loop\n--memory           Enable workspace notes and explicit recall\n\nBrowser login token is stored in DATA/web-token; subscription credentials stay server-side.');
    process.exit(0);
}
const workspace = resolve(value('--workspace', process.cwd()));
const data = resolve(value('--data', join(homedir(), '.agentic')));
await mkdir(data, { recursive: true, mode: 0o700 });
const model = value('--model', process.env.AGENTIC_MODEL ?? 'gpt-6-astra');
const client = await createDefaultAgent({ workspace, model, database: join(data, 'sessions.sqlite'), planning: args.includes('--planning'),
    memoryDatabase: args.includes('--memory') ? join(data, 'memory.sqlite') : undefined });
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
    if (!args.includes('--web') || args.includes('--terminal')) cleanups.push(await startTerminalUi(client));
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return; shuttingDown = true;
        for (const cleanup of cleanups.reverse()) await cleanup();
        await client.close();
    };
    process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
} catch (error) { for (const cleanup of cleanups.reverse()) await cleanup(); await client.close(); throw error; }
