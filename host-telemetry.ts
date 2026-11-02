/** Collects sanitized local host CPU, GPU, unified memory, OS Mach threads and Simulator/Docker/Chrome workload metrics. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, homedir, loadavg, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { emptyHostSnapshot, type HostSnapshot, type HostWorkloads } from './web/host-monitor.ts';

export { emptyHostSnapshot, type HostSnapshot, type HostWorkloads };

const execFileAsync = promisify(execFile);

export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

const round1 = (value: number): number => Math.round(value * 10) / 10;
const clampPercent = (value: number): number => round1(Math.min(100, Math.max(0, value)));

export function sumCpuTimes(cores: { times: CpuTimes }[]): CpuTimes {
  const sum: CpuTimes = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
  for (const core of cores) {
    sum.user += core.times.user;
    sum.nice += core.times.nice;
    sum.sys += core.times.sys;
    sum.idle += core.times.idle;
    sum.irq += core.times.irq;
  }
  return sum;
}

export function computeCpuDelta(previous: CpuTimes | null, current: CpuTimes): {
  usedPercent: number | null;
  userPercent: number | null;
  sysPercent: number | null;
} {
  if (!previous) return { usedPercent: null, userPercent: null, sysPercent: null };
  const userDelta = current.user - previous.user + (current.nice - previous.nice);
  const sysDelta = current.sys - previous.sys + (current.irq - previous.irq);
  const idleDelta = current.idle - previous.idle;
  const totalDelta = userDelta + sysDelta + idleDelta;
  if (totalDelta <= 0 || userDelta < 0 || sysDelta < 0 || idleDelta < 0) {
    return { usedPercent: null, userPercent: null, sysPercent: null };
  }
  return {
    usedPercent: clampPercent(((userDelta + sysDelta) / totalDelta) * 100),
    userPercent: clampPercent((userDelta / totalDelta) * 100),
    sysPercent: clampPercent((sysDelta / totalDelta) * 100),
  };
}

export function parseGpuIoreg(output: string): HostSnapshot['gpu'] {
  const modelMatch = output.match(/"model"\s*=\s*"([^"]+)"/);
  const coresMatch = output.match(/"gpu-core-count"\s*=\s*(\d+)/);
  const statsMatch = output.match(/"PerformanceStatistics"\s*=\s*\{([^}]+)\}/);
  const statsText = statsMatch ? statsMatch[1] : '';
  const readStat = (key: string): number | null => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = statsText.match(new RegExp(`"${escaped}"\\s*=\\s*(-?\\d+)`));
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const deviceUtil = readStat('Device Utilization %');
  const rendererUtil = readStat('Renderer Utilization %');
  const tilerUtil = readStat('Tiler Utilization %');
  return {
    model: modelMatch ? modelMatch[1].trim().slice(0, 80) : null,
    cores: coresMatch ? Number(coresMatch[1]) : null,
    utilizationPercent: deviceUtil !== null ? clampPercent(deviceUtil) : null,
    rendererPercent: rendererUtil !== null ? clampPercent(rendererUtil) : null,
    tilerPercent: tilerUtil !== null ? clampPercent(tilerUtil) : null,
    inUseMemoryBytes: readStat('In use system memory'),
    allocMemoryBytes: readStat('Alloc system memory'),
  };
}

export function parseVmStat(vmStatText: string, totalBytes: number, swapText = ''): HostSnapshot['memory'] {
  const pageSizeMatch = vmStatText.match(/page size of (\d+) bytes/i);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384;
  const readPages = (label: string): number | null => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = vmStatText.match(new RegExp(`${escaped}:\\s+(\\d+)\\.`));
    return match ? Number(match[1]) : null;
  };
  const anonymous = readPages('Anonymous pages');
  const purgeable = readPages('Pages purgeable') ?? 0;
  const wired = readPages('Pages wired down');
  const compressed = readPages('Pages occupied by compressor');
  const fileBacked = readPages('File-backed pages');

  let swapTotalBytes: number | null = null;
  let swapUsedBytes: number | null = null;
  const swapMatch = swapText.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M/i);
  if (swapMatch) {
    swapTotalBytes = Math.round(Number(swapMatch[1]) * 1024 * 1024);
    swapUsedBytes = Math.round(Number(swapMatch[2]) * 1024 * 1024);
  }

  if (anonymous === null || wired === null || compressed === null || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return {
      usedPercent: null,
      usedBytes: null,
      totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
      appBytes: null,
      wiredBytes: null,
      compressedBytes: null,
      cachedBytes: null,
      swapUsedBytes,
      swapTotalBytes,
    };
  }

  const appBytes = Math.max(0, (anonymous - purgeable) * pageSize);
  const wiredBytes = wired * pageSize;
  const compressedBytes = compressed * pageSize;
  const usedBytes = Math.min(totalBytes, appBytes + wiredBytes + compressedBytes);
  const cachedBytes = fileBacked !== null ? (fileBacked + purgeable) * pageSize : null;
  return {
    usedPercent: clampPercent((usedBytes / totalBytes) * 100),
    usedBytes,
    totalBytes,
    appBytes,
    wiredBytes,
    compressedBytes,
    cachedBytes,
    swapUsedBytes,
    swapTotalBytes,
  };
}

export function parsePsThreads(psText: string): HostSnapshot['threads'] {
  let total = 0;
  let running = 0;
  const pids = new Set<number>();
  const runningPids = new Set<number>();
  for (const raw of psText.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('USER')) continue;
    const match = line.match(/(\d+)\s+(\S+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const state = match[2];
    if (!Number.isInteger(pid) || pid <= 0) continue;
    total++;
    pids.add(pid);
    if (state.startsWith('R')) {
      running++;
      runningPids.add(pid);
    }
  }
  if (total === 0) {
    return { total: null, running: null, processes: null, runningProcesses: null };
  }
  return {
    total,
    running,
    processes: pids.size,
    runningProcesses: runningPids.size,
  };
}

export function parseFootprintBytes(output: string): Map<number, number> {
  const result = new Map<number, number>();
  const pattern = /\[(\d+)\]:[^\n]*?\bFootprint:\s*(\d+)\s*B\b/g;
  for (const match of output.matchAll(pattern)) {
    const pid = Number(match[1]);
    const bytes = Number(match[2]);
    if (Number.isInteger(pid) && pid > 0 && Number.isFinite(bytes) && bytes >= 0) {
      result.set(pid, bytes);
    }
  }
  for (const raw of output.split('\n')) {
    const match = raw.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const bytes = Number(match[2]);
    if (Number.isInteger(pid) && pid > 0 && Number.isFinite(bytes) && bytes >= 0) {
      result.set(pid, bytes);
    }
  }
  return result;
}

export function parseWorkloads(
  psTableText: string,
  logicalCores: number | null = null,
  guestContainers: number | null = null,
  footprintByPid: ReadonlyMap<number, number> | null = null,
): HostWorkloads {
  type ProcRow = { pid: number; ppid: number; cpu: number; rssKib: number; args: string };
  const rows: ProcRow[] = [];
  for (const raw of psTableText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpu = Number(match[3]);
    const rssKib = Number(match[4]);
    const args = match[5];
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(cpu) || !Number.isFinite(rssKib)) continue;
    rows.push({ pid, ppid, cpu, rssKib, args });
  }
  if (!rows.length) {
    return emptyHostSnapshot().workloads!;
  }

  const childrenMap = new Map<number, number[]>();
  for (const row of rows) {
    let list = childrenMap.get(row.ppid);
    if (!list) {
      list = [];
      childrenMap.set(row.ppid, list);
    }
    list.push(row.pid);
  }

  const launchdSimPids = new Set(
    rows.filter(r => /(?:^|\/)launchd_sim\b/.test(r.args)).map(r => r.pid),
  );
  const simTree = new Set<number>(launchdSimPids);
  const queue = [...launchdSimPids];
  while (queue.length) {
    const current = queue.pop()!;
    for (const child of childrenMap.get(current) ?? []) {
      if (!simTree.has(child)) {
        simTree.add(child);
        queue.push(child);
      }
    }
  }

  const simRows = rows.filter(
    r =>
      simTree.has(r.pid) ||
      /CoreSimulator|Simulator\.app\/Contents\/MacOS|SimulatorTrampoline|simdiskimaged|\.simruntime\//i.test(r.args),
  );
  const dockerRows = rows.filter(r =>
    /\/Applications\/Docker\.app\/|com\.docker\.|com\.apple\.Virtualization\.VirtualMachine\b|OrbStack\.app\//i.test(r.args),
  );
  const chromeRows = rows.filter(r =>
    /Google Chrome\.app\/|Google Chrome Framework\.framework\/|Chrome Debug \d+\.app\/|chrome-headless-shell/i.test(r.args),
  );
  const headlessRows = chromeRows.filter(r =>
    /mars-headless-chrome|chrome-headless-profile|--headless\b/i.test(r.args),
  );
  const headlessSet = new Set(headlessRows.map(r => r.pid));
  const guiRows = chromeRows.filter(r => !headlessSet.has(r.pid));
  const headlessRenderers = headlessRows.filter(r => /--type=renderer\b/.test(r.args)).length;

  const llamaServerRows = rows.filter(r => /(?:^|\/)llama-server\b/i.test(r.args));
  const rerankRows = llamaServerRows.filter(r => /--rerank\b|reranker|--port\s+18972\b/i.test(r.args));
  const rerankSet = new Set(rerankRows.map(r => r.pid));
  const embedQueryRows = llamaServerRows.filter(
    r => !rerankSet.has(r.pid) && /--port\s+18971\b/i.test(r.args),
  );
  const embedQuerySet = new Set(embedQueryRows.map(r => r.pid));
  const embedBatchRows = llamaServerRows.filter(
    r =>
      !rerankSet.has(r.pid) &&
      !embedQuerySet.has(r.pid) &&
      (/--embeddings\b|embedding|--port\s+18970\b/i.test(r.args) || /local-search\/runtime/i.test(r.args)),
  );
  const localSearchWorkers = rows.filter(
    r => /(?:^|\/)local-search\b/i.test(r.args) && !/(?:^|\/)llama-server\b/i.test(r.args),
  );
  const vectorModelRows = [...embedBatchRows, ...embedQueryRows, ...rerankRows, ...localSearchWorkers];

  const procMem = (item: ProcRow) => Math.max(item.rssKib * 1024, footprintByPid?.get(item.pid) ?? 0);
  const sumRss = (list: ProcRow[]) => list.reduce((acc, item) => acc + item.rssKib * 1024, 0);
  const sumFootprintOrRss = (list: ProcRow[]) =>
    list.reduce((acc, item) => acc + (footprintByPid?.get(item.pid) ?? item.rssKib * 1024), 0);
  const sumMem = (list: ProcRow[]) => list.reduce((acc, item) => acc + procMem(item), 0);
  const sumCpu = (list: ProcRow[]) => round1(list.reduce((acc, item) => acc + item.cpu, 0));
  const hostShare = (cpuSum: number) =>
    logicalCores && logicalCores > 0 ? clampPercent(cpuSum / logicalCores) : null;

  const simCpu = sumCpu(simRows);
  const dockerCpu = sumCpu(dockerRows);
  const chromeTotalCpu = sumCpu(chromeRows);
  const headlessCpu = sumCpu(headlessRows);
  const guiCpu = sumCpu(guiRows);

  const embedBatchMem = sumMem(embedBatchRows);
  const embedBatchCpu = sumCpu(embedBatchRows);
  const embedQueryMem = sumMem(embedQueryRows);
  const embedQueryCpu = sumCpu(embedQueryRows);
  const rerankMem = sumMem(rerankRows);
  const rerankCpu = sumCpu(rerankRows);
  const vectorTotalMem = sumMem(vectorModelRows);
  const vectorTotalCpu = sumCpu(vectorModelRows);
  const onlineModels =
    (embedBatchRows.length > 0 ? 1 : 0) +
    (embedQueryRows.length > 0 ? 1 : 0) +
    (rerankRows.length > 0 ? 1 : 0);

  return {
    simulator: {
      memoryBytes: sumFootprintOrRss(simRows),
      cpuPercent: simCpu,
      hostCpuPercent: hostShare(simCpu),
      bootedDevices: launchdSimPids.size,
      processes: simRows.length,
    },
    docker: {
      memoryBytes: sumRss(dockerRows),
      cpuPercent: dockerCpu,
      hostCpuPercent: hostShare(dockerCpu),
      containers: guestContainers,
      processes: dockerRows.length,
    },
    chrome: {
      totalMemoryBytes: sumRss(chromeRows),
      totalCpuPercent: chromeTotalCpu,
      totalProcesses: chromeRows.length,
      headlessMemoryBytes: sumRss(headlessRows),
      headlessCpuPercent: headlessCpu,
      headlessProcesses: headlessRows.length,
      headlessRenderers,
      guiMemoryBytes: sumRss(guiRows),
      guiCpuPercent: guiCpu,
      guiProcesses: guiRows.length,
    },
    vectorModels: {
      totalMemoryBytes: vectorTotalMem,
      totalCpuPercent: vectorTotalCpu,
      hostCpuPercent: hostShare(vectorTotalCpu),
      embeddingMemoryBytes: embedBatchMem + embedQueryMem,
      embeddingCpuPercent: round1(embedBatchCpu + embedQueryCpu),
      embedBatchMemoryBytes: embedBatchMem,
      embedBatchCpuPercent: embedBatchCpu,
      embedQueryMemoryBytes: embedQueryMem,
      embedQueryCpuPercent: embedQueryCpu,
      rerankMemoryBytes: rerankMem,
      rerankCpuPercent: rerankCpu,
      onlineModels,
      processes: vectorModelRows.length,
    },
  };
}

async function readGuestContainerCount(): Promise<number | null> {
  try {
    const guestPath = resolve(homedir(), '.local/state/cpu-watchdog/guest.json');
    const guest = JSON.parse(await readFile(guestPath, 'utf8'));
    if (Array.isArray(guest?.containers)) return guest.containers.length;
  } catch { /* Fall back when watchdog guest state is absent. */ }
  return null;
}

const FOOTPRINT_PROBE = [
  'import { dlopen, FFIType, ptr } from "bun:ffi";',
  'const lib = dlopen("/usr/lib/libSystem.B.dylib", {',
  '  proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },',
  '  proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },',
  '});',
  'const pids = new Int32Array(16384);',
  'const count = lib.symbols.proc_listallpids(ptr(pids), pids.byteLength);',
  'const buf = new BigUint64Array(64);',
  'const out = [];',
  'for (let i = 0; i < count; i++) {',
  '  const pid = pids[i];',
  '  if (pid > 0 && lib.symbols.proc_pid_rusage(pid, 4, ptr(buf)) === 0) out.push(pid + " " + buf[9]);',
  '}',
  'process.stdout.write(out.join("\\n"));',
].join(' ');

async function readProcessFootprints(): Promise<string> {
  try {
    const res = await execFileAsync('bun', ['-e', FOOTPRINT_PROBE], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    if (res.stdout.trim()) return res.stdout;
  } catch { /* Fall back to /usr/bin/footprint when bun is unavailable. */ }
  return execFileAsync('/usr/bin/footprint', ['--noCategories', '-f', 'bytes', '-p', 'llama-server'], {
    timeout: 3000,
    maxBuffer: 2 * 1024 * 1024,
  })
    .then(res => res.stdout)
    .catch((err: any) => (typeof err?.stdout === 'string' ? err.stdout : ''));
}

/** `workloads: false` skips the per-process scans; remote agents only report the four core cards. */
export function startHostMonitor(onUpdate: (snapshot: HostSnapshot) => void, intervalMs = 2000,
  { workloads: withWorkloads = true }: { workloads?: boolean } = {}): () => void {
  let previousCpu: CpuTimes | null = sumCpuTimes(cpus());
  let polling = false;
  let stopped = false;

  const sample = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const coreList = cpus();
      const logicalCores = coreList.length || null;
      const currentCpu = sumCpuTimes(coreList);
      const cpuDelta = computeCpuDelta(previousCpu, currentCpu);
      previousCpu = currentCpu;
      const loads = loadavg();

      const [ioregOut, vmStatOut, swapOut, psThreadsOut, psProcsOut, footprintOut, guestContainers] = await Promise.all([
        execFileAsync('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 })
          .then(res => res.stdout).catch(() => ''),
        execFileAsync('/usr/bin/vm_stat', [], { timeout: 3000 })
          .then(res => res.stdout).catch(() => ''),
        execFileAsync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 3000 })
          .then(res => res.stdout).catch(() => ''),
        execFileAsync('/bin/ps', ['-AxMo', 'pid=,state='], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 })
          .then(res => res.stdout).catch(() => ''),
        withWorkloads ? execFileAsync('/bin/ps', ['-Axo', 'pid=,ppid=,%cpu=,rss=,args='], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 })
          .then(res => res.stdout).catch(() => '') : '',
        withWorkloads ? readProcessFootprints() : '',
        withWorkloads ? readGuestContainerCount() : null,
      ]);

      if (stopped) return;
      const gpu = parseGpuIoreg(ioregOut);
      const memory = parseVmStat(vmStatOut, totalmem(), swapOut);
      const threads = parsePsThreads(psThreadsOut);
      const workloads = withWorkloads
        ? parseWorkloads(psProcsOut, logicalCores, guestContainers, parseFootprintBytes(footprintOut)) : undefined;
      const chip = gpu.model ?? (coreList[0]?.model ? coreList[0].model.trim().slice(0, 80) : null);

      onUpdate({
        observedAt: new Date().toISOString(),
        stale: false,
        chip,
        cpu: {
          ...cpuDelta,
          cores: logicalCores,
          loadAvg: [round1(loads[0]), round1(loads[1]), round1(loads[2])],
        },
        gpu,
        memory,
        threads,
        workloads,
      });
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
  };
}
