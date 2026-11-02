/** Install a built dashboard in an immutable local release and register its launchd process. */
import { execFileSync } from 'node:child_process';
import { mkdir, cp, writeFile, symlink, rename, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { defaultAccounts, parseAccounts } from './report.ts';

const { values } = parseArgs({ options: { 'range-script': { type: 'string' },
  accounts: { type: 'string', default: defaultAccounts }, host: { type: 'string', default: '127.0.0.1' },
  label: { type: 'string', default: 'local.token-arcade' } } });
const script = resolve(values['range-script'] ?? fileURLToPath(new URL('vendor/remaining-range/range.ts', import.meta.url)));
await access(script);
const aliases = parseAccounts(values.accounts);
const source = dirname(fileURLToPath(import.meta.url));
execFileSync('bun', ['build', resolve(source, 'web/app.ts'), '--outdir', resolve(source, 'web/dist'), '--target', 'browser'], { stdio: 'inherit' });
execFileSync('bun', ['build', resolve(source, 'speed-worker.ts'), resolve(source, 'speed-probe.ts'), '--outdir', resolve(source, 'dist'), '--target', 'node'], { stdio: 'inherit' });
const base = resolve(homedir(), '.local/share/token-dashboard');
const release = resolve(base, 'releases', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(release, { recursive: true });
await cp(source, release, { recursive: true, filter: path => !path.split('/').includes('node_modules') });
// Freeze the reader alongside the release so workspace moves cannot break a running collector.
const installedScript = resolve(release, 'vendor/remaining-range', script.split('/').at(-1)!);
await cp(dirname(script), dirname(installedScript), { recursive: true });
await symlink(release, resolve(base, 'current-next'));
await rename(resolve(base, 'current-next'), resolve(base, 'current'));
const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));
const node = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
const domain = `gui/${process.getuid!()}`;
const label = values.label!;
const plist = resolve(homedir(), 'Library/LaunchAgents', `${label}.plist`);
let checkpointSource = script;
try {
  checkpointSource = execFileSync('/usr/bin/plutil', ['-extract',
    'EnvironmentVariables.TOKEN_SPEED_CHECKPOINT_SOURCE', 'raw', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || script;
} catch { /* Older installations keyed checkpoints by the supplied reader path. */ }
await mkdir(dirname(plist), { recursive: true });
const variables = { PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/bin:/bin`,
  TOKEN_RANGE_SCRIPT: installedScript, TOKEN_SPEED_CHECKPOINT_SOURCE: checkpointSource,
  TOKEN_ACCOUNTS: aliases.join(','), TOKEN_HOST: values.host!, TOKEN_SPEED_FALLBACK: '0' };
await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>${escapeXml(resolve(base, 'current/server.ts'))}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(variables).map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${escapeXml(resolve(base, 'process.log'))}</string>
<key>StandardErrorPath</key><string>${escapeXml(resolve(base, 'process-error.log'))}</string>
</dict></plist>`);
try { execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'pipe' }); }
catch (error: any) { if (!String(error.stderr).includes('No such process')) throw error; }
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'pipe' });
    break;
  } catch (error: any) {
    if (error.status !== 5 || attempt === 19) throw error;
    await setTimeout(200);
  }
}
process.stdout.write(`Installed ${label}; release ${release}\n`);
