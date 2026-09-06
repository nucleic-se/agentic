import { runContextEvaluation } from './context.js';
try {
    const report = await runContextEvaluation();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.passed ? 0 : 1;
} catch (error) {
    process.stdout.write(`${JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
}
