import { runRetentionEvaluation } from './retention.js';
const report = await runRetentionEvaluation();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
