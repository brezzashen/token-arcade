import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeCpuDelta,
  emptyHostSnapshot,
  parseFootprintBytes,
  parseGpuIoreg,
  parsePsThreads,
  parseVmStat,
  parseWorkloads,
  sumCpuTimes,
} from './host-telemetry.ts';
import { hostMonitor } from './web/host-monitor.ts';

test('sumCpuTimes and computeCpuDelta calculate whole-host CPU utilization percentages', () => {
  const prev = sumCpuTimes([
    { times: { user: 1000, nice: 0, sys: 500, idle: 3500, irq: 0 } },
    { times: { user: 1000, nice: 0, sys: 500, idle: 3500, irq: 0 } },
  ]);
  const next = sumCpuTimes([
    { times: { user: 1400, nice: 0, sys: 700, idle: 3900, irq: 0 } },
    { times: { user: 1200, nice: 0, sys: 600, idle: 4200, irq: 0 } },
  ]);
  const delta = computeCpuDelta(prev, next);
  assert.deepEqual(delta, {
    usedPercent: 45,
    userPercent: 30,
    sysPercent: 15,
  });
  assert.deepEqual(computeCpuDelta(null, next), {
    usedPercent: null,
    userPercent: null,
    sysPercent: null,
  });
});

test('parseGpuIoreg extracts Apple Silicon GPU utilization, cores and memory counters', () => {
  const sample = `
    +-o AGXAcceleratorG17X  <class AGXAcceleratorG17X>
      {
        "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=28337012736,"Tiler Utilization %"=15,"recoveryCount"=0,"Renderer Utilization %"=27,"Device Utilization %"=33,"In use system memory"=12212142080}
        "model" = "Apple M5 Ultra"
        "gpu-core-count" = 64
      }
  `;
  assert.deepEqual(parseGpuIoreg(sample), {
    model: 'Apple M5 Ultra',
    cores: 64,
    utilizationPercent: 33,
    rendererPercent: 27,
    tilerPercent: 15,
    inUseMemoryBytes: 12212142080,
    allocMemoryBytes: 28337012736,
  });
});

test('parseVmStat computes Activity Monitor memory breakdown and swap usage', () => {
  const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    63289.
Pages active:                                1986307.
Pages inactive:                              1979719.
Pages speculative:                             12225.
Pages wired down:                            1000000.
Pages purgeable:                               20000.
File-backed pages:                           1500000.
Anonymous pages:                             2020000.
Pages occupied by compressor:                 500000.
`;
  const totalBytes = 96 * 1024 * 1024 * 1024;
  const swap = 'vm.swapusage: total = 8192.00M  used = 1024.50M  free = 7167.50M  (encrypted)';
  const parsed = parseVmStat(vmStat, totalBytes, swap);
  assert.equal(parsed.appBytes, 2000000 * 16384);
  assert.equal(parsed.wiredBytes, 1000000 * 16384);
  assert.equal(parsed.compressedBytes, 500000 * 16384);
  assert.equal(parsed.usedBytes, 3500000 * 16384);
  assert.equal(parsed.cachedBytes, 1520000 * 16384);
  assert.equal(parsed.usedPercent, 55.6);
  assert.equal(parsed.swapTotalBytes, 8192 * 1024 * 1024);
  assert.equal(parsed.swapUsedBytes, Math.round(1024.5 * 1024 * 1024));
});

test('parsePsThreads counts total Mach threads, running threads and distinct processes', () => {
  const psSample = `USER               PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND           
root                 1   ??    0.0 S    31T   0:04.61   0:00.00 /sbin/l     1 S   
                     1         0.1 R    20T   0:00.14   0:00.10             1 R   
root               102   ??    0.0 S    31T   0:00.00   0:00.00 /usr/li   102 S   
                   102         0.7 S    20T   0:00.16   0:00.10           102 S   
alice              555   ??   12.0 R    31T   0:01.00   0:02.00 node      555 R+  
`;
  assert.deepEqual(parsePsThreads(psSample), {
    total: 5,
    running: 2,
    processes: 3,
    runningProcesses: 2,
  });
});

test('parseWorkloads aggregates Simulator tree, Docker VM/host, Chrome total vs Headless, and Vector/Rerank models', () => {
  const sample = `
31275     1   2.0  20000 launchd_sim /Users/alice/Library/Developer/CoreSimulator/Devices/A/data/var/run/launchd_bootstrap.plist
31300 31275  58.0 500000 /Users/alice/Library/Developer/CoreSimulator/Devices/A/data/Containers/Bundle/Application/B/ExampleApp.app/ExampleApp
36073     1   1.5  40000 /Applications/Docker.app/Contents/MacOS/com.docker.backend
36172     1  88.5 8000000 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine
40001     1   5.0 200000 /Users/alice/Library/Caches/mars-headless-chrome/155.0/Google Chrome.app/Contents/MacOS/Google Chrome --headless --user-data-dir=/Users/alice/.codex/shared-browser-mcp/chrome-headless-profile
40002 40001  15.0 300000 /Users/alice/Library/Caches/mars-headless-chrome/155.0/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/Users/alice/.codex/shared-browser-mcp/chrome-headless-profile
50001     1   3.0 400000 /Users/alice/Applications/Chrome Debug Ports/Chrome Debug 9223.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223
97232     1  18.0 6600000 /Users/alice/.local/share/local-search/runtime/llama/llama-server -m /Users/alice/.local/share/local-search/runtime/models/Qwen3-Embedding-4B-Q8_0.gguf --embeddings --port 18970
97239     1   6.0 4600000 /Users/alice/.local/share/local-search/runtime/llama/llama-server -m /Users/alice/.local/share/local-search/runtime/models/Qwen3-Embedding-4B-Q8_0.gguf --embeddings --port 18971
44651     1   3.0   8600 /Users/alice/.local/share/local-search/runtime/llama/llama-server -m /Users/alice/.local/share/local-search/runtime/models/qwen3-reranker-0.6b-q8_0.gguf --rerank --port 18972
`;
  const footprintSample = `
======================================================================
llama-server [97232]: 64-bit    Footprint: 2667091872 B (16384 bytes per page)
======================================================================
llama-server [44651]: 64-bit    Footprint: 2036386648 B (16384 bytes per page)
======================================================================
llama-server [97239]: 64-bit    Footprint: 713298360 B (16384 bytes per page)
======================================================================
`;
  const footprints = parseFootprintBytes(footprintSample);
  assert.equal(footprints.get(97232), 2667091872);
  assert.equal(footprints.get(44651), 2036386648);
  assert.equal(footprints.get(97239), 713298360);

  const workloads = parseWorkloads(sample, 30, 5, footprints);
  assert.deepEqual(workloads.simulator, {
    memoryBytes: 520000 * 1024,
    cpuPercent: 60,
    hostCpuPercent: 2,
    bootedDevices: 1,
    processes: 2,
  });
  assert.deepEqual(workloads.docker, {
    memoryBytes: 8040000 * 1024,
    cpuPercent: 90,
    hostCpuPercent: 3,
    containers: 5,
    processes: 2,
  });
  assert.deepEqual(workloads.chrome, {
    totalMemoryBytes: 900000 * 1024,
    totalCpuPercent: 23,
    totalProcesses: 3,
    headlessMemoryBytes: 500000 * 1024,
    headlessCpuPercent: 20,
    headlessProcesses: 2,
    headlessRenderers: 1,
    guiMemoryBytes: 400000 * 1024,
    guiCpuPercent: 3,
    guiProcesses: 1,
  });
  assert.deepEqual(workloads.vectorModels, {
    totalMemoryBytes: (6600000 + 4600000) * 1024 + 2036386648,
    totalCpuPercent: 27,
    hostCpuPercent: 0.9,
    embeddingMemoryBytes: (6600000 + 4600000) * 1024,
    embeddingCpuPercent: 24,
    embedBatchMemoryBytes: 6600000 * 1024,
    embedBatchCpuPercent: 18,
    embedQueryMemoryBytes: 4600000 * 1024,
    embedQueryCpuPercent: 6,
    rerankMemoryBytes: 2036386648,
    rerankCpuPercent: 3,
    onlineModels: 3,
    processes: 3,
  });

  const simFootprints = parseFootprintBytes('31275 8388608\n31300 67108864\n');
  assert.equal(simFootprints.get(31275), 8388608);
  assert.equal(simFootprints.get(31300), 67108864);
  const dedupedWorkloads = parseWorkloads(sample, 30, 5, simFootprints);
  assert.equal(dedupedWorkloads.simulator.memoryBytes, 8388608 + 67108864);
});

test('hostMonitor renders CPU, GPU, memory, concurrent OS threads and Simulator/Docker/Chrome/Vector cards', () => {
  const emptyMarkup = hostMonitor(emptyHostSnapshot());
  assert.match(emptyMarkup, /SYS \/ 本机硬件与并发线程监控/);
  assert.match(emptyMarkup, /采集中…/);

  const populatedMarkup = hostMonitor({
    observedAt: '2026-10-22T15:30:00.000Z',
    stale: false,
    chip: 'Apple M5 Ultra',
    cpu: { usedPercent: 42.5, userPercent: 28.1, sysPercent: 14.4, cores: 30, loadAvg: [9.5, 10.1, 12.3] },
    gpu: { model: 'Apple M5 Ultra', cores: 64, utilizationPercent: 33, rendererPercent: 27, tilerPercent: 15, inUseMemoryBytes: 12 * 1024 ** 3, allocMemoryBytes: 24 * 1024 ** 3 },
    memory: {
      usedPercent: 73.1,
      usedBytes: 70.2 * 1024 ** 3,
      totalBytes: 96 * 1024 ** 3,
      appBytes: 36.7 * 1024 ** 3,
      wiredBytes: 17.5 * 1024 ** 3,
      compressedBytes: 16 * 1024 ** 3,
      cachedBytes: 24 * 1024 ** 3,
      swapUsedBytes: 6.7 * 1024 ** 3,
      swapTotalBytes: 8 * 1024 ** 3,
    },
    threads: { total: 12015, running: 94, processes: 1923, runningProcesses: 56 },
    workloads: {
      simulator: { memoryBytes: 26.2 * 1024 ** 3, cpuPercent: 102.6, hostCpuPercent: 3.4, bootedDevices: 2, processes: 637 },
      docker: { memoryBytes: 10.1 * 1024 ** 3, cpuPercent: 156.4, hostCpuPercent: 5.2, containers: 5, processes: 10 },
      chrome: {
        totalMemoryBytes: 4.4 * 1024 ** 3,
        totalCpuPercent: 19.3,
        totalProcesses: 53,
        headlessMemoryBytes: 2.49 * 1024 ** 3,
        headlessCpuPercent: 19.3,
        headlessProcesses: 21,
        headlessRenderers: 10,
        guiMemoryBytes: 1.91 * 1024 ** 3,
        guiCpuPercent: 0,
        guiProcesses: 32,
      },
      vectorModels: {
        totalMemoryBytes: 12.62 * 1024 ** 3,
        totalCpuPercent: 17.2,
        hostCpuPercent: 0.6,
        embeddingMemoryBytes: 10.72 * 1024 ** 3,
        embeddingCpuPercent: 17.2,
        embedBatchMemoryBytes: 6.33 * 1024 ** 3,
        embedBatchCpuPercent: 17.2,
        embedQueryMemoryBytes: 4.39 * 1024 ** 3,
        embedQueryCpuPercent: 0,
        rerankMemoryBytes: 1.9 * 1024 ** 3,
        rerankCpuPercent: 0,
        onlineModels: 3,
        processes: 3,
      },
    },
  });
  assert.match(populatedMarkup, /42\.5%/);
  assert.match(populatedMarkup, /30 CORES/);
  assert.match(populatedMarkup, /64 CORES/);
  assert.match(populatedMarkup, /12,015/);
  assert.match(populatedMarkup, /Xcode 模拟器/);
  assert.match(populatedMarkup, /已启动模拟器 <b>2 台<\/b>/);
  assert.match(populatedMarkup, /Docker 容器与虚拟机/);
  assert.match(populatedMarkup, /运行中容器 <b>5 个<\/b>/);
  assert.match(populatedMarkup, /Chrome 浏览器 \(整体 \+ Headless\)/);
  assert.match(populatedMarkup, /Headless 渲染页 <b>10<\/b>/);
  assert.match(populatedMarkup, /向量与 Rerank 模型/);
  assert.match(populatedMarkup, /索引 <b>6\.33 GB<\/b> \(17\.2%\)/);
  assert.match(populatedMarkup, /查询 <b>4\.39 GB<\/b> \(0%\)/);
  assert.match(populatedMarkup, /Rerank 0\.6B 重排/);
  for (const kind of ['cpu', 'gpu', 'memory', 'threads', 'simulator', 'docker', 'chrome', 'vector']) {
    assert.match(populatedMarkup, new RegExp(`data-host-kind="${kind}"`));
  }
  assert.equal((populatedMarkup.match(/class="host-unit-line/g) ?? []).length, 16);
  assert.equal((populatedMarkup.match(/class="host-unit-line is-empty"/g) ?? []).length, 4);
});

test('browser bundle web/dist/app.js excludes node child_process and util shims', async () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const bundle = await readFile(resolve(root, 'web/dist/app.js'), 'utf8');
  assert.doesNotMatch(bundle, /promisify\(execFile\)/);
  assert.doesNotMatch(bundle, /\/\/ host-telemetry\.ts/);
});
