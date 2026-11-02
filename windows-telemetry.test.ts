import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowsSnapshot, parseNvidiaSmi, parseWindowsCounters } from './windows-telemetry.ts';
import { failureLabel, parseRemoteHosts } from './remote-host-streams.ts';
import { remoteHosts } from './web/remote-hosts.ts';

// Shapes captured from a Windows host on 2026-10-31.
const COUNTERS = '{"processes":461,"contextSwitches":148375,"cached":19555942400,"threads":8550,"commitLimit":72522125312,'
  + '"pageFileUsedMiB":313,"pageFileTotalMiB":6036,"queue":2,"wslCpu":837,"wslMemory":26976890880,"vmCount":1,"committed":70421229568}';
const SMI = 'NVIDIA GeForce RTX 5090, 0, 1220, 32607, 35, 20.10\r\n';

test('Windows CIM counters parse, and WSL readings need a running vmmem process', () => {
  const c = parseWindowsCounters(COUNTERS)!;
  assert.equal(c.threads, 8550);
  assert.equal(c.queue, 2);
  assert.equal(c.wslMemory, 26976890880);
  const idle = parseWindowsCounters(COUNTERS.replace('"vmCount":1', '"vmCount":0'))!;
  assert.equal(idle.wslCpu, null);
  assert.equal(idle.wslMemory, null);
  assert.equal(parseWindowsCounters('#< CLIXML'), null);
});

test('nvidia-smi CSV parses into MiB and watts', () => {
  assert.deepEqual(parseNvidiaSmi(SMI), { name: 'NVIDIA GeForce RTX 5090', utilization: 0, usedMiB: 1220, totalMiB: 32607, temperature: 35, power: 20.1 });
  assert.equal(parseNvidiaSmi(''), null);
  assert.equal(parseNvidiaSmi('NVIDIA, [N/A], 1, 2, 3, 4')!.utilization, null);
});

test('a Windows snapshot derives used memory from available bytes and WSL share from logical cores', () => {
  const s = buildWindowsSnapshot({ cpu: { usedPercent: 12.5, userPercent: 10, sysPercent: 2.5 }, cores: 16, totalBytes: 64 * 2 ** 30,
    freeBytes: 16 * 2 ** 30, counters: parseWindowsCounters(COUNTERS), gpu: parseNvidiaSmi(SMI), observedAt: '2026-10-31T05:00:00.000Z' });
  assert.equal(s.platform, 'win32');
  assert.equal(s.memory.usedPercent, 75);
  assert.equal(s.memory.usedBytes, 48 * 2 ** 30);
  assert.equal(s.memory.swapUsedBytes, 313 * 2 ** 20);
  assert.equal(s.gpu.inUseMemoryBytes, 1220 * 2 ** 20);
  assert.equal(s.windows!.wslHostCpuPercent, 52.3);
  assert.equal(s.threads.running, null);
});

test('remote host specs, failure labels and panels', () => {
  assert.deepEqual(parseRemoteHosts('win,mbp').map(spec => spec.id), ['win', 'mbp']);
  assert.deepEqual(parseRemoteHosts(), []);
  assert.throws(() => parseRemoteHosts('nas'), /Unknown remote host/);
  assert.equal(failureLabel(1, 'Error: Cannot find module C:\\x'), '采集端未安装');
  assert.equal(failureLabel(255, 'ssh: connect to host'), 'SSH 连接失败');
  const snapshot = buildWindowsSnapshot({ cpu: { usedPercent: 1, userPercent: 1, sysPercent: 0 }, cores: 16, totalBytes: 2 ** 30, freeBytes: 0,
    counters: null, gpu: null, observedAt: '2026-10-31T05:00:00.000Z' });
  const html = remoteHosts([{ id: 'win', label: 'Windows', snapshot: { ...snapshot, hostname: 'PC<x>' }, stale: false, error: null },
    { id: 'mbp', label: 'SSH MBP', snapshot: null, stale: true, error: 'SSH 连接失败' }]);
  assert.match(html, /REMOTE \/ Windows · PC&lt;x&gt;/);
  assert.match(html, /WINDOWS THREADS/);
  assert.match(html, /离线 · SSH 连接失败/);
});
