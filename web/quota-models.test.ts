/** Verify the per-model split of a quota cycle and the single-model capacity estimates against hand-computed examples. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { projectReport } from '../report.ts';
import { estimate, rateFor } from './pricing.ts';
import { consumption, overview } from './overview.ts';
import { quotaName, tokens } from './format.ts';
import { calibrate, cycleModelEstimate, quotaModels } from './quota-models.ts';
import { claudeResponse } from '../vendor/remaining-range/claude-usage-records.ts';

const near = (actual: number | null | undefined, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const long = (thresholdInputTokens = 272_000, values: Record<string, number> = {}) => ({ thresholdInputTokens, inputTokens: 0, cachedInputTokens: 0,
  cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, outputTokens: 0, ...values });
const parts = (scale = 1) => ({ inputTokens: 1_000_000 * scale, cachedInputTokens: 800_000 * scale, cacheCreationInputTokens: 100_000 * scale,
  cacheCreation1hInputTokens: 100_000 * scale, outputTokens: 100_000 * scale, totalTokens: 1_100_000 * scale, longContext: long() });
function account(models: Record<string, unknown>[], usedPercent = 50) {
  return projectReport('cc6', { quota: { windows: [{ window: 'claude:seven_day', windowMinutes: 10080, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: '2099-01-01T00:00:00.000Z', cycleTokens: { ...parts(models.length), status: 'observed', byModel: models } }] } });
}

test('a cycle splits its used quota by API-equivalent cost and reprices the whole mix per model', () => {
  const report = account([{ model: 'claude-opus-5-5', ...parts() }, { model: 'claude-fable-5-2', ...parts() }]);
  const result = cycleModelEstimate(report.windows[0], report.provider)!;
  near(result.spent, 3.36 + 6.56); near(result.perPoint, 9.92 / 50);
  near(result.actual[0].points, 3.36 / 9.92 * 50); near(result.actual[1].points, 6.56 / 9.92 * 50);
  near(result.mix.fullTokens, 4_400_000); near(result.mix.remainingTokens, 2_200_000); near(result.mix.ratio, 1);
  const opus = result.single.find(row => row.model === 'claude-opus-5-5')!, fable = result.single.find(row => row.model === 'claude-fable-5-2')!;
  near(opus.fullTokens, 19.84 / 6.72 * 2_200_000); near(opus.ratio, 9.92 / 6.72); near(opus.usdPerMillion, 6.72 / 2.2);
  near(fable.fullTokens, 19.84 / 13.12 * 2_200_000); near(fable.remainingTokens, 19.84 / 13.12 * 1_100_000);
  near(fable.fullTokens! / opus.fullTokens!, 6.72 / 13.12);
  const html = quotaModels(report, report.windows[0]);
  assert.match(html, /data-quota-model="claude-fable-5-2"/); assert.match(html, /未校准 · 按 API 单价比例/);
});

test('an unpriced model or an unused window gives no capacity estimate', () => {
  const unknown = account([{ model: 'claude-opus-5-5', ...parts() }, { model: 'claude-future-9', ...parts() }]);
  const result = cycleModelEstimate(unknown.windows[0], unknown.provider)!;
  assert.equal(result.spent, null); assert.deepEqual(result.unpriced, ['claude-future-9']);
  assert.equal(result.single[0].fullTokens, null);
  assert.match(quotaModels(unknown, unknown.windows[0]), /未核对单价：claude-future-9/);
  const idle = account([{ model: 'claude-opus-5-5', ...parts() }], 0);
  assert.equal(cycleModelEstimate(idle.windows[0], idle.provider)!.perPoint, null);
  assert.equal(quotaModels(projectReport('cc6', {}), undefined), '');
});

test('Claude Haiku 5.5 prices requests above 100K prompt tokens at its higher tier and needs counters at that threshold', () => {
  const row = { model: 'claude-haiku-5-5', ...parts(), cacheCreation1hInputTokens: 0,
    longContext: long(100_000, { inputTokens: 400_000, cachedInputTokens: 300_000, cacheCreationInputTokens: 50_000, outputTokens: 20_000 }) };
  const report = account([row]);
  near(estimate(report.windows[0].cycle!.models[0], rateFor('claude-haiku-5-5'))!.cost, 0.05625 + 0.12125);
  const wrongThreshold = account([{ ...row, longContext: long(272_000) }]);
  assert.equal(estimate(wrongThreshold.windows[0].cycle!.models[0], rateFor('claude-haiku-5-5')), null);
});

test('burn factors come from windows on the base model and windows with a real share of another model', () => {
  // Five-hour windows: two on Opus alone fix $2 per point; Fable windows then burn twice their API-equivalent cost.
  const window = (models: Record<string, unknown>[], usedPercent: number, minutes = 300, scale = models.length) => projectReport('cc1', { quota: { windows: [{ window: 'w',
    windowMinutes: minutes, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: '2099-01-01T00:00:00.000Z',
    cycleTokens: { ...parts(scale), status: 'observed', byModel: models } }] } });
  const opus = { model: 'claude-opus-5-5', ...parts(10) }, fable = { model: 'claude-fable-5-2', ...parts(1) };
  const accounts = [window([opus], 17), window([opus], 17), window([fable], 7), window([{ ...opus, ...parts(1) }, fable], 8),
    window([{ ...opus, ...parts(100) }], 50, 10080, 100)];
  const calibration = calibrate(accounts, 'Claude');
  assert.equal(calibration.base, 'claude-opus-5-5');
  const factor = calibration.factors.get('claude-fable-5-2')!;
  assert.equal(factor.windows, 2); near(factor.low, (8 * 33.6 / 17 - 3.36) / 6.56); near(factor.high, 7 * 33.6 / 17 / 6.56);
  near(factor.factor, (factor.low + factor.high) / 2);
  // The weekly window on Opus alone: the same quota on Fable holds price ratio times burn factor fewer tokens.
  const weekly = cycleModelEstimate(accounts[4].windows[0], 'Claude', calibration)!;
  const single = (model: string) => weekly.single.find(row => row.model === model)!;
  near(single('claude-opus-5-5').ratio, 1); near(single('claude-fable-5-2').ratio, 3.36 / (6.56 * factor.factor));
  near(single('claude-fable-5-2').fullTokens, 220_000_000 * 3.36 / (6.56 * factor.factor));
  assert.match(quotaModels(accounts[4], accounts[4].windows[0], accounts), /实测 2 个窗口/);
  assert.equal(calibrate(accounts.slice(0, 3), 'Claude').factors.size, 0, 'one window is not a calibration');
});

test('a cache-write split that sums below the total keeps the row priceable; a missing split is named as such', () => {
  const usage = (cache_creation?: Record<string, number>) => ({ id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 4, cache_read_input_tokens: 52_660,
    cache_creation_input_tokens: 30_272, output_tokens: 853, cache_creation } });
  assert.equal(claudeResponse(usage({ ephemeral_1h_input_tokens: 29_202, ephemeral_5m_input_tokens: 0 }), 0, 't', 'u', 's').cacheCreation1hInput, 30_272);
  assert.equal(claudeResponse(usage({ ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 10_272 }), 0, 't', 'u', 's').cacheCreation1hInput, 20_000);
  assert.equal(claudeResponse(usage({ ephemeral_1h_input_tokens: 40_000, ephemeral_5m_input_tokens: 0 }), 0, 't', 'u', 's').cacheCreation1hInput, null);
  assert.equal(claudeResponse(usage(), 0, 't', 'u', 's').cacheCreation1hInput, null);
  const incomplete = account([{ model: 'claude-opus-5-5', ...parts(), cacheCreation1hInputTokens: null }]);
  const html = quotaModels(incomplete, incomplete.windows[0]);
  assert.match(html, /本机记录缺少计价所需的拆分计数：claude-opus-5-5/); assert.doesNotMatch(html, /未核对单价/);
});

test('Gemini cycle windows estimate Carbon and Argon quota capacity at the 200K long-context threshold', () => {
  const carbonRow = { model: 'gemini-4-carbon', inputTokens: 1_000_000, cachedInputTokens: 800_000,
    cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, outputTokens: 100_000, totalTokens: 1_100_000,
    longContext: long(200_000) };
  const gemini = projectReport('ag1', { quota: { windows: [{ window: 'gemini-5h', windowMinutes: 300,
    usedPercent: 10, remainingPercent: 90, resetsAt: '2099-01-01T00:00:00.000Z',
    cycleTokens: { ...carbonRow, status: 'observed', byModel: [carbonRow] } }] } });
  const result = cycleModelEstimate(gemini.windows[0], gemini.provider)!;
  near(result.spent, 1.48);
  near(result.perPoint, 0.148);
  assert.ok(result.single.some(row => row.model === 'gemini-4-carbon'));
  assert.ok(result.single.some(row => row.model === 'gemini-4-argon'));
  assert.ok(result.single.some(row => row.model === 'gemini-3.8-flash'));
  const html = quotaModels(gemini, gemini.windows[0]);
  assert.match(html, /data-quota-model="gemini-4-carbon"/);
  assert.match(html, /data-quota-model="gemini-4-argon"/);
});

test('overview and consumption render Fable 5 weekly limits, weekly-total caps and 24h token summaries', () => {
  const cc3 = projectReport('cc3', {
    account: { label: 'cc3 · team' }, planReportedByServer: 'team',
    tokens: {
      samples: [{ id: 'last_24_hours', status: 'observed', totalTokens: 640_000_000, inputTokens: 638_000_000, cachedInputTokens: 630_000_000, outputTokens: 2_000_000 }],
      byModel: [{ model: 'claude-fable-5-2', status: 'observed', totalTokens: 420_000_000, inputTokens: 418_500_000, cachedInputTokens: 414_000_000, outputTokens: 1_500_000 }],
    },
    quota: { windows: [
      { window: 'claude:session:0', windowMinutes: 300, usedPercent: 79, remainingPercent: 21, resetsAt: '2099-01-01T06:30:00Z' },
      { window: 'claude:weekly_all:1', windowMinutes: 10080, usedPercent: 53, remainingPercent: 47, resetsAt: '2099-01-07T05:00:00Z',
        cycleTokens: { ...parts(2), status: 'observed', tokensPerQuotaPercentagePoint: 12_000_000, projectedTokensPerFullWindow: 1_200_000_000 } },
      { window: 'claude:weekly_scoped:2', windowMinutes: 10080, usedPercent: 100, remainingPercent: 0, resetsAt: '2099-01-07T05:00:00Z',
        modelScope: { id: null, label: 'Fable' }, weeklyShare: { usedPercent: 50, allowancePercent: 50 },
        cycleTokens: { ...parts(1), status: 'observed', tokensPerQuotaPercentagePoint: 8_400_000, projectedTokensPerFullWindow: 840_000_000 } },
    ] },
  });
  const cc2 = projectReport('cc2', {
    account: { label: 'cc2 · work' }, planReportedByServer: 'team',
    quota: { windows: [
      { window: 'claude:weekly_all:1', windowMinutes: 10080, usedPercent: 100, remainingPercent: 0, resetsAt: '2099-01-04T00:00:00Z' },
      { window: 'claude:weekly_scoped:2', windowMinutes: 10080, usedPercent: 16, remainingPercent: 84, resetsAt: '2099-01-04T00:00:00Z',
        modelScope: { id: null, label: 'Fable' }, weeklyShare: { usedPercent: 8, allowancePercent: 50 } },
    ] },
  });
  const co1 = projectReport('co1', { account: { label: 'co1 · main' }, planReportedByServer: 'pro',
    quota: { windows: [{ window: 'codex:primary', windowMinutes: 10080, usedPercent: 32, remainingPercent: 68, resetsAt: '2099-01-02T00:00:00Z' }] } });
  assert.equal(quotaName(cc3.windows[2]), '周额度 · Fable 5');
  assert.equal(tokens(88), '88');
  assert.equal(tokens(14_008), '0.014 百万');
  const html = overview([cc3, cc2, co1]);
  assert.match(html, /Fable 5 剩余/);
  assert.match(html, /Fable 5 已耗尽 · 占周额 50%\/50%/);
  assert.match(html, /受周总额限制 \(0%\) · 占周额 8%\/50%/);
  assert.match(html, /6\.4 亿/);
  assert.match(html, /Fable 5 · 4\.2 亿/);
  const table03 = consumption([cc3]);
  assert.match(table03, /周额度 · Fable 5 · 独立模型限额/);
  assert.match(table03, /8\.4 百万/);
});
