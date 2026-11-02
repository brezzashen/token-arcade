/** Verify exact API equivalents, the 30-day projection and the subscription discount against hand-computed examples. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { projectReport } from '../report.ts';
import { accountCost, estimate, rateFor, pricing } from './pricing.ts';

const near = (actual: number | null | undefined, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const longContext = (values: Record<string, number> = {}) => ({ thresholdInputTokens: 272_000, inputTokens: 0, cachedInputTokens: 0,
  cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, outputTokens: 0, ...values });

function model(values: Record<string, unknown> = {}, alias: 'cc1' | 'co2' = 'cc1') {
  return projectReport(alias, { tokens: { byModel: [{ model: 'claude-opus-5-5',
    inputTokens: 1_000_000, cachedInputTokens: 800_000, cacheCreationInputTokens: 100_000, cacheCreation1hInputTokens: 100_000,
    outputTokens: 100_000, longContext: longContext(), ...values }] } });
}

test('Claude prices each cache write at its recorded TTL and every input subset once', () => {
  const hour = estimate(model().models[0], rateFor('claude-opus-5-5'))!;
  near(hour.cost, 3.36); near(hour.baseline, 6);
  const minutes = estimate(model({ cacheCreation1hInputTokens: 0 }).models[0], rateFor('claude-opus-5-5'))!;
  near(minutes.cost, 3.06);
  assert.equal(estimate(model({ cacheCreation1hInputTokens: null }).models[0], rateFor('claude-opus-5-5')), null);
});

test('GPT bills only requests above 272K input at long-context rates', () => {
  const row = model({ model: 'gpt-6.1-sol', cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0,
    longContext: longContext({ inputTokens: 400_000, cachedInputTokens: 300_000, outputTokens: 20_000 }) }).models[0];
  const cost = estimate(row, rateFor('gpt-6.1-sol'))!;
  near(cost.cost, 1.81); near(cost.baseline, 3.9); assert.equal(cost.longRequests, true);
  assert.equal(estimate({ ...row, longContext: null }, rateFor('gpt-6.1-sol')), null);
});

test('the subscription discount divides the monthly fee by the 30-day projection', () => {
  const cost = accountCost(model());
  near(cost.dayCost, 3.36); near(cost.monthly, 100.8); assert.equal(cost.fee, 125); near(cost.discount, 125 / 100.8 * 100);
  assert.match(pricing([model()]), /\$100\.80/);
  assert.match(pricing([model()]), /12\.40 折/);
});

test('unknown models, missing usage and inconsistent subsets never produce a price', () => {
  assert.equal(rateFor('claude-haiku-4-5-20251001')?.input, 1);
  assert.equal(rateFor('claude-opus-5-5-custom'), undefined);
  assert.equal(estimate(model().models[0], undefined), null);
  assert.equal(estimate(model({ cachedInputTokens: null }).models[0], rateFor('claude-opus-5-5')), null);
  assert.equal(estimate(model({ cacheCreationInputTokens: 300_000 }).models[0], rateFor('claude-opus-5-5')), null);
  assert.equal(estimate(model({ inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, outputTokens: 0 }).models[0], rateFor('claude-opus-5-5')), null);
  const account = projectReport('co1', {});
  assert.equal(accountCost(account).discount, null);
  assert.match(pricing([account]), /暂无可比用量/);
  assert.match(pricing([account]), /\$500\.00/);
  const gemini = projectReport('gm', { tokens: { byModel: [{ model: 'gemini-4-argon',
    inputTokens: 1_000_000, cachedInputTokens: 800_000, cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0,
    outputTokens: 100_000, reasoningOutputTokens: 40_000, longContext: longContext() }] } });
  assert.equal(gemini.provider, 'Gemini');
  assert.equal(gemini.models[0].reasoningOutputTokens, 40_000);
  assert.equal(accountCost(gemini).dayCost, null);
  assert.equal(accountCost(gemini).fee, null);
  assert.equal(accountCost(gemini).discount, null);
  assert.match(pricing([gemini]), /月费待确认/);
  assert.match(pricing([gemini]), /Google AI Ultra/);
  assert.doesNotMatch(pricing([gemini]), /按量计费|Vertex AI/);
});
