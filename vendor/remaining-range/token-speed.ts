/** CLI entry for an opt-in live Codex output benchmark, distinct from speed.ts's passive task history. Prints a table or JSON and never saves a benchmark result. */
import { parseArgs } from 'node:util';
import { benchmarkOptions, parseBenchmarkOptions, runBenchmark, formatBenchmark } from './benchmark.ts';

try {
  const { values } = parseArgs({ options: { ...benchmarkOptions, home: { type: 'string' },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    process.stdout.write(`Usage: node token-speed.ts [--project PATH] [--file PATH] [--json] [--dry-run]
Defaults: three Codex models (Fast and Standard) and Opus 5.5, Sonnet 5.5, Fable 5.1 (Standard only).
One short code-analysis turn per model/mode; high effort; no repeated rounds; Claude output cap=1200 tokens.
Options: --models LIST --mode both|fast|standard --effort low|medium|high|xhigh
         --start-line N --lines 20..500 --timeout-seconds 15..300 --home PATH
         --claude-home PATH --claude-budget-usd 0.01..0.20
Live runs consume account allowance; dry-run freezes project input without model calls.
`);
  } else {
    const report = await runBenchmark(parseBenchmarkOptions(values), text => process.stderr.write(`${text}\n`));
    process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : formatBenchmark(report)}\n`);
    if (report.status !== 'dry_run' && !report.trials.some(t => t.status === 'ok')) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'unavailable', error: error instanceof Error ? error.message : 'Unexpected failure' })}\n`);
  process.exitCode = 1;
}
