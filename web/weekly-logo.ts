/** Render provider pixel plates whose bottom-anchored color fill represents account-wide weekly quota, so usage drains it from the top. */
import type { AccountReport } from '../report.ts';
import { percent, usd } from './format.ts';
import { providerPixels } from './logos/pixels.ts';
import { providerName } from './provider.ts';

const gridSize = providerPixels.Claude.length;
const plateSize = gridSize * 4;
const logoPaths = Object.fromEntries(Object.entries(providerPixels).map(([provider, rows]) => [provider,
  rows.flatMap((row, y) => [...row].flatMap((pixel, x) => pixel === '1' ? [`M${x * 4} ${y * 4}h3v3h-3z`] : [])).join(''),
]));

export function weeklyLogo(value: number | null | undefined, account: AccountReport) {
  const remaining = value === null || value === undefined || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
  if (remaining === null && account.provider !== 'Grok' && account.provider !== 'Gemini') return '<span class="accent" aria-label="本周剩余额度未知">—</span>';
  // Billing-only accounts have no allowance to drain; their provider plate stays fully colored.
  const height = 'billing' in account && account.billing ? plateSize : Math.round((remaining ?? 0) / 100 * gridSize) * 4;
  const id = `weekly-${account.alias}`;
  const path = logoPaths[account.provider];
  const billed = remaining === null && account.billing?.costUsd != null ? usd(account.billing.costUsd) : null;
  const accessibility = remaining === null ? `role="img" aria-label="${providerName(account.provider)} ${billed ? `本月真实账单 ${billed}` : account.billing ? '按量计费无周额度' : '本周剩余额度未知'}"`
    : `role="progressbar" aria-label="${providerName(account.provider)} 本周剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}" aria-valuetext="剩余 ${percent(remaining)}"`;
  return `<div class="weekly-logo" data-provider="${account.provider}" ${accessibility}>
    <svg viewBox="0 0 ${plateSize} ${plateSize}" aria-hidden="true" shape-rendering="crispEdges">
      <defs>
        <pattern id="${id}-empty" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="3" height="3" class="pixel-empty"/></pattern>
        <pattern id="${id}-color" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="3" height="3" class="pixel-color"/></pattern>
        <clipPath id="${id}-fill"><rect y="${plateSize - height}" width="${plateSize}" height="${height}"/></clipPath>
      </defs>
      <rect width="${plateSize}" height="${plateSize}" fill="url(#${id}-empty)"/>
      <path d="${path}" class="pixel-ink"/>
      <g class="quota-fill" clip-path="url(#${id}-fill)"><rect width="${plateSize}" height="${plateSize}" fill="url(#${id}-color)"/><path d="${path}" class="pixel-ink"/></g>
    </svg><strong>${billed ?? percent(remaining)}</strong></div>`;
}
