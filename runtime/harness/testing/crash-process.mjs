// Loaded against a fresh temporary TypeScript build, never the workspace dist/.
import { appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [compiled, directory, mode] = process.argv.slice(2);
const { createHarness } = await import(pathToFileURL(join(compiled, 'runtime/harness/host.js')));
const { createSqliteSessionStore } = await import(pathToFileURL(join(compiled, 'runtime/harness/stores.js')));
const { conversationalLoop, fullHistoryContext } = await import(pathToFileURL(join(compiled, 'runtime/harness/defaults.js')));
const usage = { inputTokens: 1, outputTokens: 1 };
const send = message => process.send(message);
function ledger(kind) {
    const fd = openSync(join(directory, 'effects.log'), 'a');
    try { appendFileSync(fd, `${kind}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}
async function barrier(name, sessionId) {
    send({ type: 'barrier', name, sessionId });
    await new Promise(() => {});
}
let sessionId;
const store = await createSqliteSessionStore(join(directory, 'sessions.sqlite'));
const commit = store.commit.bind(store);
store.commit = async (...args) => {
    await commit(...args);
    const event = args[3];
    if (mode === 'before-dispatch' && event.type === 'tool.intent') await barrier(mode, args[0]);
    if (mode === 'after-receipt' && event.type === 'tool.completed') await barrier(mode, args[0]);
};
const provider = {
    async turn(request) {
        ledger('model');
        if (request.messages.some(message => message.role === 'tool_result')) {
            return { message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage };
        }
        return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'effect-call', name: 'write', args: {} }] }, stopReason: 'tool_use', usage };
    },
    async structured() { throw new Error('Unused'); },
};
const tools = {
    tools: () => [{ name: 'write', description: 'Write one durable marker', parameters: { type: 'object' } }],
    validate: (_name, args) => ({ ok: true, args }),
    async call() {
        ledger('effect');
        if (mode === 'after-effect') await barrier(mode, sessionId);
        return { ok: true, content: 'written' };
    },
};
const client = await createHarness().compose({ extensions: [{ id: 'crash-fixture', version: '1', apiVersion: 1, roles: {
    store: () => store, provider: () => provider, tools: () => tools,
    loop: () => conversationalLoop(), context: () => fullHistoryContext(),
    policy: () => ({ evaluate: () => ({ kind: 'allow' }) }),
} }] });
process.on('message', async message => {
    try {
        if (message.command === 'resume') { await client.resume(sessionId); await client.wait(sessionId); }
        else if (message.command === 'resolve') {
            const record = await client.get(sessionId);
            const operation = record.operations.find(item => item.kind === 'tool' && item.status === 'unknown');
            await client.resolveOperation(sessionId, operation.id, {
                expectedRevision: record.revision, evidence: message.evidence, result: message.result,
            });
        } else if (message.command === 'close') {
            await client.close(); send({ type: 'reply', requestId: message.requestId }); process.disconnect(); return;
        }
        send({ type: 'reply', requestId: message.requestId, record: await client.get(sessionId), events: await client.events(sessionId) });
    } catch (error) { send({ type: 'reply', requestId: message.requestId, error: error.message }); }
});
if (mode === 'recover') {
    sessionId = (await client.list())[0].id;
    send({ type: 'ready', record: await client.get(sessionId), events: await client.events(sessionId) });
} else {
    sessionId = (await client.create()).id;
    await client.submit(sessionId, 'Perform the external write once', { commandId: 'original-input' });
}
