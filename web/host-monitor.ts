/** Renders the top-of-page local host monitor panel for CPU, GPU, unified memory, OS Mach threads and key workloads. */
import { escape, percent, time } from './format.ts';

export type HostWorkloads = {
  simulator: {
    memoryBytes: number | null;
    cpuPercent: number | null;
    hostCpuPercent: number | null;
    bootedDevices: number | null;
    processes: number | null;
  };
  docker: {
    memoryBytes: number | null;
    cpuPercent: number | null;
    hostCpuPercent: number | null;
    containers: number | null;
    processes: number | null;
  };
  chrome: {
    totalMemoryBytes: number | null;
    totalCpuPercent: number | null;
    totalProcesses: number | null;
    headlessMemoryBytes: number | null;
    headlessCpuPercent: number | null;
    headlessProcesses: number | null;
    headlessRenderers: number | null;
    guiMemoryBytes: number | null;
    guiCpuPercent: number | null;
    guiProcesses: number | null;
  };
  vectorModels: {
    totalMemoryBytes: number | null;
    totalCpuPercent: number | null;
    hostCpuPercent: number | null;
    embeddingMemoryBytes: number | null;
    embeddingCpuPercent: number | null;
    embedBatchMemoryBytes: number | null;
    embedBatchCpuPercent: number | null;
    embedQueryMemoryBytes: number | null;
    embedQueryCpuPercent: number | null;
    rerankMemoryBytes: number | null;
    rerankCpuPercent: number | null;
    onlineModels: number | null;
    processes: number | null;
  };
};

export type HostSnapshot = {
  observedAt: string | null;
  stale: boolean;
  chip: string | null;
  cpu: {
    usedPercent: number | null;
    userPercent: number | null;
    sysPercent: number | null;
    cores: number | null;
    loadAvg: [number, number, number] | null;
  };
  gpu: {
    model: string | null;
    cores: number | null;
    utilizationPercent: number | null;
    rendererPercent: number | null;
    tilerPercent: number | null;
    inUseMemoryBytes: number | null;
    allocMemoryBytes: number | null;
  };
  memory: {
    usedPercent: number | null;
    usedBytes: number | null;
    totalBytes: number | null;
    appBytes: number | null;
    wiredBytes: number | null;
    compressedBytes: number | null;
    cachedBytes: number | null;
    swapUsedBytes: number | null;
    swapTotalBytes: number | null;
  };
  threads: {
    total: number | null;
    running: number | null;
    processes: number | null;
    runningProcesses: number | null;
  };
  workloads?: HostWorkloads;
};

export function emptyHostSnapshot(): HostSnapshot {
  return {
    observedAt: null,
    stale: true,
    chip: null,
    cpu: { usedPercent: null, userPercent: null, sysPercent: null, cores: null, loadAvg: null },
    gpu: { model: null, cores: null, utilizationPercent: null, rendererPercent: null, tilerPercent: null, inUseMemoryBytes: null, allocMemoryBytes: null },
    memory: { usedPercent: null, usedBytes: null, totalBytes: null, appBytes: null, wiredBytes: null, compressedBytes: null, cachedBytes: null, swapUsedBytes: null, swapTotalBytes: null },
    threads: { total: null, running: null, processes: null, runningProcesses: null },
    workloads: {
      simulator: { memoryBytes: null, cpuPercent: null, hostCpuPercent: null, bootedDevices: null, processes: null },
      docker: { memoryBytes: null, cpuPercent: null, hostCpuPercent: null, containers: null, processes: null },
      chrome: {
        totalMemoryBytes: null,
        totalCpuPercent: null,
        totalProcesses: null,
        headlessMemoryBytes: null,
        headlessCpuPercent: null,
        headlessProcesses: null,
        headlessRenderers: null,
        guiMemoryBytes: null,
        guiCpuPercent: null,
        guiProcesses: null,
      },
      vectorModels: {
        totalMemoryBytes: null,
        totalCpuPercent: null,
        hostCpuPercent: null,
        embeddingMemoryBytes: null,
        embeddingCpuPercent: null,
        embedBatchMemoryBytes: null,
        embedBatchCpuPercent: null,
        embedQueryMemoryBytes: null,
        embedQueryCpuPercent: null,
        rerankMemoryBytes: null,
        rerankCpuPercent: null,
        onlineModels: null,
        processes: null,
      },
    },
  };
}

type HostIconKind = 'cpu' | 'gpu' | 'memory' | 'threads' | 'simulator' | 'docker' | 'chrome' | 'vector';

const hostIcons: Record<HostIconKind, string> = {
  cpu: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/><rect x="9.5" y="9.5" width="5" height="5" fill="currentColor" stroke="none"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>`,
  gpu: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M3 5v14M3 7h18v10H3"/><circle cx="10" cy="12" r="3"/><rect x="15.5" y="9.2" width="2.5" height="2.5" fill="currentColor" stroke="none"/><rect x="15.5" y="12.5" width="2.5" height="2.5" fill="currentColor" stroke="none"/><path d="M7 17v2h6v-2"/></svg>`,
  memory: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M2 7h20v8H2z"/><rect x="5" y="9.5" width="3" height="3" fill="currentColor" stroke="none"/><rect x="10.5" y="9.5" width="3" height="3" fill="currentColor" stroke="none"/><rect x="16" y="9.5" width="3" height="3" fill="currentColor" stroke="none"/><path d="M5 15v3M9 15v3M15 15v3M19 15v3"/></svg>`,
  threads: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M3 6h12M3 12h18M3 18h14"/><circle cx="18" cy="6" r="2.2" fill="currentColor"/><circle cx="9" cy="12" r="2.2" fill="currentColor"/><circle cx="19" cy="18" r="2.2" fill="currentColor"/></svg>`,
  simulator: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2"/><path d="M10.5 5.5h3M10 18.5h4"/><path d="M9.5 14.2l2.5-5.2 2.5 5.2M10.2 13h3.6"/></svg>`,
  docker: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><rect x="4" y="9" width="2.6" height="2.4"/><rect x="7.2" y="9" width="2.6" height="2.4"/><rect x="10.4" y="9" width="2.6" height="2.4"/><rect x="13.6" y="9" width="2.6" height="2.4"/><rect x="7.2" y="6" width="2.6" height="2.4"/><rect x="10.4" y="6" width="2.6" height="2.4"/><rect x="10.4" y="3" width="2.6" height="2.4"/><path d="M21.8 11.6c-.7-.5-1.7-.6-2.5-.3-.2-.9-.8-1.6-1.6-2-.4.6-.5 1.5-.2 2.2-.5.4-1.2.6-2 .6H2.2c-.3 2.8.8 5.2 3 6.5 1.8 1 4.4 1.3 7.1.8 3.2-.6 5.6-2.5 6.8-5.3 1.1.1 2.2-.3 2.9-1.2-.1-.5-.1-.9-.2-1.3z"/></svg>`,
  chrome: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/><path d="M12 8.5h7.8M8.9 13.8L5 7.1M15.1 13.8l-3.9 6.8"/></svg>`,
  vector: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><circle cx="6" cy="6" r="2.2" fill="currentColor"/><circle cx="18" cy="6" r="2.2" fill="currentColor"/><circle cx="6" cy="18" r="2.2" fill="currentColor"/><circle cx="18" cy="18" r="2.2" fill="currentColor"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/><path d="M7.8 7.8l2.5 2.5M16.2 7.8l-2.5 2.5M7.8 16.2l2.5-2.5M16.2 16.2l-2.5-2.5M6 8.5v7M18 8.5v7M8.5 6h7M8.5 18h7"/></svg>`,
};

export const cardHead = (kind: HostIconKind, title: string, badge: string) =>
  `<div class="card-label host-card-head"><span class="account-identity"><span class="provider-icon host-icon" data-host-kind="${kind}">${hostIcons[kind]}</span><span class="host-head-text"><b>${escape(title)}</b><small>${escape(badge)}</small></span></span></div>`;

export const gib = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const value = bytes / (1024 * 1024 * 1024);
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} GB`;
};

export const count = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US');

export const meter = (ratioPercent: number | null, label: string, blocks = 16) => {
  const filled = ratioPercent === null ? 0 : Math.min(blocks, Math.max(0, Math.round((ratioPercent / 100) * blocks)));
  return `<div class="pixel-meter host-meter" role="img" aria-label="${escape(label)}">${Array.from(
    { length: blocks },
    (_, i) => `<i class="${i < filled ? 'filled' : ''}"></i>`,
  ).join('')}</div>`;
};

/** The four core cards (CPU, GPU, memory, threads) of a macOS snapshot, shared by the local and remote Mac panels. */
export function coreCards(snapshot: HostSnapshot, available: boolean): string {
  const cpuUsed = available ? snapshot.cpu.usedPercent : null;
  const gpuUsed = available ? snapshot.gpu.utilizationPercent : null;
  const memUsed = available ? snapshot.memory.usedPercent : null;
  const threadsTotal = available ? snapshot.threads.total : null;
  const threadsRunning = available ? snapshot.threads.running : null;
  const threadRatio =
    threadsTotal !== null && threadsRunning !== null && snapshot.cpu.cores
      ? Math.min(100, (threadsRunning / snapshot.cpu.cores) * 100)
      : threadsTotal !== null
        ? Math.min(100, (threadsTotal / 20_000) * 100)
        : null;

  const loadAvg =
    available && snapshot.cpu.loadAvg
      ? snapshot.cpu.loadAvg.map(v => v.toFixed(1)).join(' / ')
      : '—';
  const idleThreads =
    threadsTotal !== null && threadsRunning !== null ? Math.max(0, threadsTotal - threadsRunning) : null;

  return `<div class="host-grid">
      <article class="host-card">
        ${cardHead('cpu', 'CPU 使用率', snapshot.cpu.cores ? `${snapshot.cpu.cores} CORES` : 'CPU')}
        <div class="host-number">${percent(cpuUsed)}<small>总占用</small></div>
        ${meter(cpuUsed, `CPU 使用率 ${percent(cpuUsed)}`)}
        <div class="host-sub"><span>用户 <b>${percent(available ? snapshot.cpu.userPercent : null)}</b></span><span>系统 <b>${percent(available ? snapshot.cpu.sysPercent : null)}</b></span></div>
        <div class="host-sub"><span>负载 (1/5/15m)</span><b>${escape(loadAvg)}</b></div>
      </article>
      <article class="host-card">
        ${cardHead('gpu', 'GPU 使用率', snapshot.gpu.cores ? `${snapshot.gpu.cores} CORES` : 'METAL')}
        <div class="host-number">${percent(gpuUsed)}<small>设备负载</small></div>
        ${meter(gpuUsed, `GPU 使用率 ${percent(gpuUsed)}`)}
        <div class="host-sub"><span>渲染 <b>${percent(available ? snapshot.gpu.rendererPercent : null)}</b></span><span>Tiler <b>${percent(available ? snapshot.gpu.tilerPercent : null)}</b></span></div>
        <div class="host-sub"><span>显存占用 <b>${gib(available ? snapshot.gpu.inUseMemoryBytes : null)}</b></span><span>分配 <b>${gib(available ? snapshot.gpu.allocMemoryBytes : null)}</b></span></div>
      </article>
      <article class="host-card">
        ${cardHead('memory', '内存使用', snapshot.memory.totalBytes ? gib(snapshot.memory.totalBytes) : 'UNIFIED RAM')}
        <div class="host-number">${percent(memUsed)}<small>${available && snapshot.memory.usedBytes !== null ? `${gib(snapshot.memory.usedBytes)} 已用` : '统一内存'}</small></div>
        ${meter(memUsed, `内存使用率 ${percent(memUsed)}`)}
        <div class="host-sub"><span>应用 <b>${gib(available ? snapshot.memory.appBytes : null)}</b></span><span>联动 <b>${gib(available ? snapshot.memory.wiredBytes : null)}</b></span><span>压缩 <b>${gib(available ? snapshot.memory.compressedBytes : null)}</b></span></div>
        <div class="host-sub"><span>文件缓存 <b>${gib(available ? snapshot.memory.cachedBytes : null)}</b></span><span>交换区 <b>${gib(available ? snapshot.memory.swapUsedBytes : null)}</b></span></div>
      </article>
      <article class="host-card">
        ${cardHead('threads', '同时进行线程数', 'OS MACH THREADS')}
        <div class="host-number">${count(threadsTotal)}<small>系统并发线程</small></div>
        ${meter(threadRatio, `运行中线程 ${count(threadsRunning)}`)}
        <div class="host-sub"><span>运行中 (R) <b>${count(threadsRunning)}</b></span><span>休眠/等待 <b>${count(idleThreads)}</b></span></div>
        <div class="host-sub"><span>系统进程 <b>${count(available ? snapshot.threads.processes : null)}</b></span><span>活跃进程 <b>${count(available ? snapshot.threads.runningProcesses : null)}</b></span></div>
      </article>
    </div>`;
}

export function hostMonitor(snapshot: HostSnapshot): string {
  const available = !snapshot.stale && snapshot.observedAt !== null;
  const chip = snapshot.chip ?? snapshot.gpu.model ?? '本机硬件';
  const defaults = emptyHostSnapshot().workloads!;
  const workloads = available && snapshot.workloads ? snapshot.workloads : defaults;
  const sim = workloads.simulator;
  const docker = workloads.docker;
  const chrome = workloads.chrome;
  const vec = workloads.vectorModels ?? defaults.vectorModels;
  const totalRam = snapshot.memory.totalBytes ?? 96 * 1024 ** 3;
  const memShare = (bytes: number | null) =>
    bytes !== null && totalRam > 0 ? Math.min(100, (bytes / totalRam) * 100) : null;

  return `<section class="panel host-monitor"><div class="panel-title"><h2>SYS / 本机硬件与并发线程监控</h2><span>${escape(chip)} · ${snapshot.stale ? '采集中…' : `每 2 秒刷新 · ${time(snapshot.observedAt)}`}</span></div>
    ${coreCards(snapshot, available)}
    <div class="host-workloads">
      <article class="host-card">
        ${cardHead('simulator', 'Xcode 模拟器', 'XCODE SIMULATOR')}
        <div class="host-dual">
          <div><div class="host-number is-compact">${gib(sim.memoryBytes)}</div><small class="host-unit"><span class="host-unit-line">内存占用 (物理)</span><span class="host-unit-line is-empty" aria-hidden="true">&nbsp;</span></small></div>
          <div><div class="host-number is-compact">${percent(sim.cpuPercent)}</div><small class="host-unit"><span class="host-unit-line">CPU · 整机 ${percent(sim.hostCpuPercent)}</span><span class="host-unit-line is-empty" aria-hidden="true">&nbsp;</span></small></div>
        </div>
        ${meter(memShare(sim.memoryBytes), `模拟器内存占比 ${percent(memShare(sim.memoryBytes))}`)}
        <div class="host-sub"><span>已启动模拟器 <b>${sim.bootedDevices !== null ? `${count(sim.bootedDevices)} 台` : '—'}</b></span><span>模拟器进程 <b>${count(sim.processes)}</b></span></div>
      </article>
      <article class="host-card">
        ${cardHead('docker', 'Docker 容器与虚拟机', 'DOCKER / LINUX VM')}
        <div class="host-dual">
          <div><div class="host-number is-compact">${gib(docker.memoryBytes)}</div><small class="host-unit"><span class="host-unit-line">内存占用 (VM+宿主)</span><span class="host-unit-line is-empty" aria-hidden="true">&nbsp;</span></small></div>
          <div><div class="host-number is-compact">${percent(docker.cpuPercent)}</div><small class="host-unit"><span class="host-unit-line">CPU · 整机 ${percent(docker.hostCpuPercent)}</span><span class="host-unit-line is-empty" aria-hidden="true">&nbsp;</span></small></div>
        </div>
        ${meter(memShare(docker.memoryBytes), `Docker 内存占比 ${percent(memShare(docker.memoryBytes))}`)}
        <div class="host-sub"><span>运行中容器 <b>${docker.containers !== null ? `${count(docker.containers)} 个` : '—'}</b></span><span>Docker 宿主进程 <b>${count(docker.processes)}</b></span></div>
      </article>
      <article class="host-card">
        ${cardHead('chrome', 'Chrome 浏览器', 'CHROME / HEADLESS & GUI')}
        <div class="host-dual">
          <div><div class="host-number is-compact">${gib(chrome.totalMemoryBytes)}</div><small class="host-unit"><span class="host-unit-line">整体浏览器内存</span><span class="host-unit-line">CPU ${percent(chrome.totalCpuPercent)}</span></small></div>
          <div><div class="host-number is-compact">${gib(chrome.headlessMemoryBytes)}</div><small class="host-unit"><span class="host-unit-line">Headless 内存</span><span class="host-unit-line">CPU ${percent(chrome.headlessCpuPercent)}</span></small></div>
        </div>
        ${meter(memShare(chrome.totalMemoryBytes), `Chrome 总内存占比 ${percent(memShare(chrome.totalMemoryBytes))}`)}
        <div class="host-sub"><span>Headless 渲染页 <b>${count(chrome.headlessRenderers)}</b></span><span>有头 <b>${gib(chrome.guiMemoryBytes)}</b> (${count(chrome.guiProcesses)})</span></div>
      </article>
      <article class="host-card">
        ${cardHead('vector', '向量与 Rerank 模型', 'QWEN3-4B ×2 · RERANK 0.6B')}
        <div class="host-dual">
          <div><div class="host-number is-compact">${gib(vec.totalMemoryBytes)}</div><small class="host-unit"><span class="host-unit-line">向量合计 ${gib(vec.embeddingMemoryBytes)}</span><span class="host-unit-line">CPU ${percent(vec.totalCpuPercent)} · 整机 ${percent(vec.hostCpuPercent)}</span></small></div>
          <div><div class="host-number is-compact">${gib(vec.rerankMemoryBytes)}</div><small class="host-unit"><span class="host-unit-line">Rerank 0.6B 重排</span><span class="host-unit-line">CPU ${percent(vec.rerankCpuPercent)} · ${vec.onlineModels !== null ? `${count(vec.onlineModels)}/3 在线` : '—'}</span></small></div>
        </div>
        ${meter(memShare(vec.totalMemoryBytes), `向量与重排模型内存占比 ${percent(memShare(vec.totalMemoryBytes))}`)}
        <div class="host-sub"><span>索引 <b>${gib(vec.embedBatchMemoryBytes)}</b> (${percent(vec.embedBatchCpuPercent)})</span><span>查询 <b>${gib(vec.embedQueryMemoryBytes)}</b> (${percent(vec.embedQueryCpuPercent)})</span></div>
      </article>
    </div></section>`;
}
