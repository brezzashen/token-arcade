/** Collects Windows host CPU, NVIDIA GPU, physical/commit memory, OS threads and the Docker WSL VM for the remote host agent. */
import { execFile, spawn } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { computeCpuDelta, sumCpuTimes, type CpuTimes } from './host-telemetry.ts';
import type { RemoteSnapshot } from './web/remote-hosts.ts';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

export type WindowsCounters = {
  threads: number | null;
  processes: number | null;
  queue: number | null;
  contextSwitches: number | null;
  committed: number | null;
  commitLimit: number | null;
  cached: number | null;
  pageFileUsedMiB: number | null;
  pageFileTotalMiB: number | null;
  wslCpu: number | null;
  wslMemory: number | null;
};

export type NvidiaReading = { name: string | null; utilization: number | null; usedMiB: number | null; totalMiB: number | null;
  temperature: number | null; power: number | null };

// CIM class names are not localized, unlike PDH counter paths, so this works on a Chinese-language Windows.
const COUNTER_LOOP = `$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id PARENT_PID)) { exit }
  $s = Get-CimInstance Win32_PerfFormattedData_PerfOS_System
  $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $f = @(Get-CimInstance Win32_PageFileUsage)
  $v = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name LIKE 'vmmem%'")
  $line = @{ threads = $s.Threads; processes = $s.Processes; queue = $s.ProcessorQueueLength
    contextSwitches = $s.ContextSwitchesPersec; committed = $m.CommittedBytes; commitLimit = $m.CommitLimit
    cached = $m.StandbyCacheNormalPriorityBytes + $m.StandbyCacheReserveBytes + $m.StandbyCacheCoreBytes + $m.ModifiedPageListBytes
    pageFileUsedMiB = ($f | Measure-Object CurrentUsage -Sum).Sum; pageFileTotalMiB = ($f | Measure-Object AllocatedBaseSize -Sum).Sum
    wslCpu = ($v | Measure-Object PercentProcessorTime -Sum).Sum; wslMemory = ($v | Measure-Object WorkingSetPrivate -Sum).Sum
    vmCount = $v.Count } | ConvertTo-Json -Compress
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch { exit }
  Start-Sleep -Milliseconds 2000
}`;

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function parseWindowsCounters(line: string): WindowsCounters | null {
  let raw: any;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const hasVm = num(raw.vmCount) !== null && raw.vmCount > 0;
  return {
    threads: num(raw.threads), processes: num(raw.processes), queue: num(raw.queue),
    contextSwitches: num(raw.contextSwitches), committed: num(raw.committed), commitLimit: num(raw.commitLimit),
    cached: num(raw.cached), pageFileUsedMiB: num(raw.pageFileUsedMiB), pageFileTotalMiB: num(raw.pageFileTotalMiB),
    wslCpu: hasVm ? num(raw.wslCpu) : null, wslMemory: hasVm ? num(raw.wslMemory) : null,
  };
}

/** Parses `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(csv: string): NvidiaReading | null {
  const line = csv.split(/\r?\n/).find(row => row.trim());
  if (!line) return null;
  const [name, ...values] = line.split(',').map(cell => cell.trim());
  if (values.length < 5) return null;
  const [utilization, usedMiB, totalMiB, temperature, power] = values.map(num);
  return { name: name ? name.slice(0, 80) : null, utilization, usedMiB, totalMiB, temperature, power };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function buildWindowsSnapshot(input: { cpu: ReturnType<typeof computeCpuDelta>; cores: number | null; totalBytes: number;
  freeBytes: number; counters: WindowsCounters | null; gpu: NvidiaReading | null; observedAt: string }): RemoteSnapshot {
  const { cpu, cores, totalBytes, freeBytes, counters: c, gpu } = input;
  const usedBytes = totalBytes > 0 ? Math.max(0, totalBytes - freeBytes) : null;
  const mib = (value: number | null | undefined) => (value === null || value === undefined ? null : value * MIB);
  return {
    observedAt: input.observedAt,
    stale: false,
    chip: gpu?.name ?? null,
    platform: 'win32',
    cpu: { ...cpu, cores, loadAvg: null },
    gpu: { model: gpu?.name ?? null, cores: null, utilizationPercent: gpu?.utilization ?? null, rendererPercent: null,
      tilerPercent: null, inUseMemoryBytes: mib(gpu?.usedMiB), allocMemoryBytes: null },
    memory: { usedPercent: usedBytes !== null ? round1((usedBytes / totalBytes) * 100) : null, usedBytes,
      totalBytes: totalBytes > 0 ? totalBytes : null, appBytes: null, wiredBytes: null, compressedBytes: null,
      cachedBytes: c?.cached ?? null, swapUsedBytes: mib(c?.pageFileUsedMiB), swapTotalBytes: mib(c?.pageFileTotalMiB) },
    threads: { total: c?.threads ?? null, running: null, processes: c?.processes ?? null, runningProcesses: null },
    windows: {
      readyQueue: c?.queue ?? null,
      contextSwitchesPerSec: c?.contextSwitches ?? null,
      committedBytes: c?.committed ?? null,
      commitLimitBytes: c?.commitLimit ?? null,
      wslMemoryBytes: c?.wslMemory ?? null,
      wslCpuPercent: c?.wslCpu ?? null,
      wslHostCpuPercent: c?.wslCpu !== null && c?.wslCpu !== undefined && cores ? round1(Math.min(100, c.wslCpu / cores)) : null,
      gpuMemoryTotalBytes: mib(gpu?.totalMiB),
      gpuTemperatureC: gpu?.temperature ?? null,
      gpuPowerW: gpu?.power ?? null,
    },
  };
}

export function startWindowsMonitor(onUpdate: (snapshot: RemoteSnapshot) => void, intervalMs = 2000): () => void {
  let previousCpu: CpuTimes | null = sumCpuTimes(cpus());
  let counters: WindowsCounters | null = null;
  let polling = false;
  let stopped = false;
  const script = COUNTER_LOOP.replace('PARENT_PID', String(process.pid));
  const loop = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  loop.on('error', () => { /* Counters stay null without PowerShell. */ });
  createInterface({ input: loop.stdout! }).on('line', line => { counters = parseWindowsCounters(line) ?? counters; });

  const sample = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const coreList = cpus();
      const current = sumCpuTimes(coreList);
      const cpu = computeCpuDelta(previousCpu, current);
      previousCpu = current;
      const gpu = await execFileAsync('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
        '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true })
        .then(res => parseNvidiaSmi(res.stdout)).catch(() => null);
      if (stopped) return;
      onUpdate(buildWindowsSnapshot({ cpu, cores: coreList.length || null, totalBytes: totalmem(), freeBytes: freemem(),
        counters, gpu, observedAt: new Date().toISOString() }));
    } finally {
      polling = false;
    }
  };

  const warmup = setTimeout(() => void sample(), 250);
  const timer = setInterval(() => void sample(), intervalMs);
  return () => {
    stopped = true;
    clearTimeout(warmup);
    clearInterval(timer);
    loop.kill();
  };
}
