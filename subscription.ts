/** Antigravity runs as ag1 (Google AI Ultra subscription) and ag2 (Vertex AI pay-as-you-go; set TOKEN_VERTEX_PROJECT to label the project). */
export const geminiSubscriptionPlan = 'Google AI Ultra';
export const geminiVertexPlan = 'Vertex AI Pay-as-you-go';
export const geminiPlan = geminiSubscriptionPlan;
export const vertexRates: Record<string, { input: number; cached: number; output: number }> = {
  'gemini-4-argon': { input: 4, cached: 0.2, output: 20 },
  'gemini-3.8-flash': { input: 1.5, cached: 0.15, output: 7.5 },
  'gemini-3.5-flash-lite': { input: 0.3, cached: 0.03, output: 2.5 },
  'claude-opus-5-5': { input: 4, cached: 0.2, output: 20 },
  'claude-opus-5-5-high': { input: 4, cached: 0.2, output: 20 },
};
export const vertexStepCostUsd = (model: string | null, uncachedInput: number, cachedInput: number, output: number): number | null => {
  const rate = model ? vertexRates[model] : undefined;
  return rate ? (uncachedInput * rate.input + cachedInput * rate.cached + output * rate.output) / 1e6 : null;
};
