/** Bounded child collector: one quota report plus passive rolling local telemetry. */
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parseAccounts } from './report.ts';
import { readRollingTelemetry, unavailableTelemetry } from './rolling.ts';
import { readAntigravityReport } from './antigravity.ts';

const { values } = parseArgs({ options: { 'range-script': { type: 'string' }, account: { type: 'string' } } });
if (!values['range-script'] || !values.account) throw new Error('A range script and account are required.');
const aliases = parseAccounts(values.account);
if (aliases.length !== 1) throw new Error('Exactly one account is required.');
if (aliases[0] === 'ag1' || aliases[0] === 'ag2') {
  process.stdout.write(JSON.stringify(await readAntigravityReport(undefined, undefined, { alias: aliases[0] })));
  process.exit(0);
}
let child: ReturnType<typeof execFile> | null = null;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  child?.kill('SIGTERM');
  process.exit(1);
});
const stdout = await new Promise<string>((resolve, reject) => {
  child = execFile(process.execPath, ['--disable-warning=ExperimentalWarning', values['range-script']!, '--account', aliases[0]],
    { timeout: 40_000, maxBuffer: 24 * 1024 * 1024, killSignal: 'SIGTERM' }, (error, output) => {
      child = null;
      if (error) reject(new Error('Quota collection failed.'));
      else resolve(output);
    });
});
const report = JSON.parse(stdout);
try { Object.assign(report, await readRollingTelemetry(values['range-script'], aliases[0], report)); }
catch {
  const capturedAt = Date.parse(report.capturedAt);
  Object.assign(report, unavailableTelemetry(Number.isFinite(capturedAt) ? capturedAt : Date.now()), { telemetryError: true });
}
process.stdout.write(JSON.stringify(report));
