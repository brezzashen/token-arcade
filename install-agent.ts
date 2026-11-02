/** Build the remote host agent and install it on each SSH host, then prove it with one live `--once` snapshot. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseRemoteHosts, sshArgs, type RemoteHostSpec } from './remote-host-streams.ts';

const { values } = parseArgs({ options: { hosts: { type: 'string', default: 'win,mbp' } } });
const source = dirname(fileURLToPath(import.meta.url));
execFileSync('bun', ['build', resolve(source, 'host-agent.ts'), '--outdir', resolve(source, 'dist'), '--target', 'node'], { stdio: 'inherit' });
const bundle = readFileSync(resolve(source, 'dist/host-agent.js'));
const digest = createHash('sha256').update(bundle).digest('hex');

// scp to the Windows host fails, so the bundle travels over stdin into PowerShell (UTF-8, no BOM).
const WINDOWS_WRITE = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::InputEncoding = New-Object Text.UTF8Encoding $false
$d = Join-Path $env:LOCALAPPDATA 'token-host-agent'; New-Item -ItemType Directory -Force -Path $d | Out-Null
$p = Join-Path $d 'host-agent.mjs'; [IO.File]::WriteAllText("$p.tmp", [Console]::In.ReadToEnd(), (New-Object Text.UTF8Encoding $false))
Move-Item -Force "$p.tmp" $p; (Get-FileHash -Algorithm SHA256 $p).Hash.ToLower()`;
const MAC_WRITE = 'd="$HOME/.local/share/token-host-agent"; mkdir -p "$d" && cat > "$d/host-agent.mjs.tmp" && mv "$d/host-agent.mjs.tmp" "$d/host-agent.mjs" && shasum -a 256 "$d/host-agent.mjs" | cut -d" " -f1';

function install(spec: RemoteHostSpec) {
  const write = spec.platform === 'win32'
    ? `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WINDOWS_WRITE, 'utf16le').toString('base64')}`
    : MAC_WRITE;
  const remoteDigest = execFileSync('ssh', sshArgs(spec.id, write), { input: bundle, encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
  if (remoteDigest !== digest) throw new Error(`${spec.id}: digest mismatch (${remoteDigest} != ${digest})`);
  const line = execFileSync('ssh', ['-n', ...sshArgs(spec.id, `${spec.command} --once`)], { encoding: 'utf8', timeout: 30_000 });
  const s = JSON.parse(line.trim().split(/\r?\n/).at(-1)!);
  process.stdout.write(`${spec.id} (${s.hostname}, ${s.platform}): sha256 ${digest.slice(0, 12)} · CPU ${s.cpu.usedPercent}% · `
    + `GPU ${s.gpu.utilizationPercent}% · RAM ${s.memory.usedPercent}% · threads ${s.threads.total}\n`);
}

for (const spec of parseRemoteHosts(values.hosts)) install(spec);
