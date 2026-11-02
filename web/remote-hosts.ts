/** Renders one monitor panel per remote host (for example a Windows PC or another Mac) streamed by the host agent over SSH. */
import { escape, percent, time } from './format.ts';
import { cardHead, coreCards, count, gib, meter, type HostSnapshot } from './host-monitor.ts';

/** Windows-only readings; Apple-specific HostSnapshot fields stay null on this platform. */
export type WindowsExtras = {
  readyQueue: number | null;
  contextSwitchesPerSec: number | null;
  committedBytes: number | null;
  commitLimitBytes: number | null;
  wslMemoryBytes: number | null;
  wslCpuPercent: number | null;
  wslHostCpuPercent: number | null;
  gpuMemoryTotalBytes: number | null;
  gpuTemperatureC: number | null;
  gpuPowerW: number | null;
};

export type RemoteSnapshot = HostSnapshot & { platform?: string; hostname?: string; windows?: WindowsExtras };

export type RemoteHost = {
  id: string;
  label: string;
  snapshot: RemoteSnapshot | null;
  stale: boolean;
  error: string | null;
};

const ratio = (part: number | null, whole: number | null) =>
  part !== null && whole !== null && whole > 0 ? Math.min(100, (part / whole) * 100) : null;

function windowsCards(s: RemoteSnapshot, available: boolean): string {
  const w = s.windows;
  const on = <T>(value: T | null | undefined) => (available && value !== undefined ? value : null);
  const cpuUsed = on(s.cpu.usedPercent);
  const gpuUsed = on(s.gpu.utilizationPercent);
  const memUsed = on(s.memory.usedPercent);
  const threads = on(s.threads.total);
  const queue = on(w?.readyQueue);
  const temp = on(w?.gpuTemperatureC);
  const power = on(w?.gpuPowerW);
  return `<div class="host-grid">
      <article class="host-card">
        ${cardHead('cpu', 'CPU 使用率', s.cpu.cores ? `${s.cpu.cores} THREADS` : 'CPU')}
        <div class="host-number">${percent(cpuUsed)}<small>总占用</small></div>
        ${meter(cpuUsed, `CPU 使用率 ${percent(cpuUsed)}`)}
        <div class="host-sub"><span>用户 <b>${percent(on(s.cpu.userPercent))}</b></span><span>系统 <b>${percent(on(s.cpu.sysPercent))}</b></span></div>
        <div class="host-sub"><span>Docker WSL VM <b>${percent(on(w?.wslCpuPercent))}</b></span><span>整机 <b>${percent(on(w?.wslHostCpuPercent))}</b></span></div>
      </article>
      <article class="host-card">
        ${cardHead('gpu', 'GPU 使用率', s.gpu.model ?? 'NVIDIA')}
        <div class="host-number">${percent(gpuUsed)}<small>设备负载</small></div>
        ${meter(gpuUsed, `GPU 使用率 ${percent(gpuUsed)}`)}
        <div class="host-sub"><span>温度 <b>${temp === null ? '—' : `${temp}°C`}</b></span><span>功耗 <b>${power === null ? '—' : `${power.toFixed(0)} W`}</b></span></div>
        <div class="host-sub"><span>显存占用 <b>${gib(on(s.gpu.inUseMemoryBytes))}</b></span><span>总显存 <b>${gib(w?.gpuMemoryTotalBytes)}</b></span></div>
      </article>
      <article class="host-card">
        ${cardHead('memory', '内存使用', s.memory.totalBytes ? gib(s.memory.totalBytes) : 'RAM')}
        <div class="host-number">${percent(memUsed)}<small>${on(s.memory.usedBytes) !== null ? `${gib(s.memory.usedBytes)} 已用` : '物理内存'}</small></div>
        ${meter(memUsed, `内存使用率 ${percent(memUsed)}`)}
        <div class="host-sub"><span>已提交 <b>${gib(on(w?.committedBytes))}</b> / ${gib(w?.commitLimitBytes)}</span><span>WSL VM <b>${gib(on(w?.wslMemoryBytes))}</b></span></div>
        <div class="host-sub"><span>缓存 <b>${gib(on(s.memory.cachedBytes))}</b></span><span>页面文件 <b>${gib(on(s.memory.swapUsedBytes))}</b></span></div>
      </article>
      <article class="host-card">
        ${cardHead('threads', '同时进行线程数', 'WINDOWS THREADS')}
        <div class="host-number">${count(threads)}<small>系统并发线程</small></div>
        ${meter(ratio(queue, s.cpu.cores), `就绪队列 ${count(queue)}`)}
        <div class="host-sub"><span>就绪队列 <b>${count(queue)}</b></span><span>上下文切换/秒 <b>${count(on(w?.contextSwitchesPerSec))}</b></span></div>
        <div class="host-sub"><span>系统进程 <b>${count(on(s.threads.processes))}</b></span><span>提交率 <b>${percent(on(ratio(w?.committedBytes ?? null, w?.commitLimitBytes ?? null)))}</b></span></div>
      </article>
    </div>`;
}

function remotePanel(host: RemoteHost): string {
  const s = host.snapshot;
  const available = s !== null && !host.stale;
  const status = host.error ? `离线 · ${host.error}` : !s ? '连接中…' : host.stale ? `读数过期 · ${time(s.observedAt)}` : `每 2 秒刷新 · ${time(s.observedAt)}`;
  const chip = s?.chip ?? s?.gpu.model ?? '';
  const body = !s ? '' : s.platform === 'win32' ? windowsCards(s, available) : coreCards(s, available);
  return `<section class="panel host-monitor" id="remote-${escape(host.id)}"><div class="panel-title"><h2>REMOTE / ${escape(host.label)}${s?.hostname ? ` · ${escape(s.hostname)}` : ''}</h2><span>${chip ? `${escape(chip)} · ` : ''}${escape(status)}</span></div>
    ${body}</section>`;
}

export function remoteHosts(hosts: RemoteHost[]): string {
  return hosts.map(remotePanel).join('');
}
