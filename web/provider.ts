/** Shared provider marks and display names for aggregate tables and account selectors. */
import type { AccountReport } from '../report.ts';
const providers = {
  Claude: { name: 'Claude', file: 'claude' },
  Codex: { name: 'GPT / Codex', file: 'openai' },
  Grok: { name: 'Grok', file: 'grok' },
  Gemini: { name: 'Gemini', file: 'gemini' },
} as const;
export function providerName(provider: AccountReport['provider']) {
  return providers[provider as keyof typeof providers].name;
}
export function providerLogo(provider: AccountReport['provider']) {
  const mark = providers[provider as keyof typeof providers];
  return `<span class="provider-icon" data-provider="${provider}"><img src="/logos/${mark.file}.svg" alt="${mark.name}" width="24" height="24"></span>`;
}
