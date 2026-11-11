# Token Arcade

A local pixel dashboard for AI coding-agent subscriptions. It shows, per account:

- remaining **quota** (5-hour session and weekly windows) for Claude Code, Codex and Grok,
  plus Antigravity/Gemini when installed;
- **token consumption** from the conversation records the CLIs already write (rolling
  1/3/5/24-hour and current-cycle totals, cache hit rate, hourly burn, standard-price equivalents);
- passive **output speed** (token/s) per account, model and mode;
- optional CPU/GPU/memory panels for this machine and for remote hosts reached over SSH.

Everything runs on your own machine. The server listens on `127.0.0.1` by default,
reads each account with that account's own login, never stores credentials, and the
public JSON omits message text, file paths, thread IDs and raw provider errors.
Quota reads are the CLIs' own usage endpoints; no model call is made.

中文简介：本地运行的 AI 编码订阅额度与 token 用量面板（Claude Code / Codex / Grok / Antigravity）。
只读取本机各账号自己的登录和对话记录，默认只监听 127.0.0.1，不上传任何数据。
想让编码代理帮你安装，把 [AGENT_SETUP.md](AGENT_SETUP.md) 里的提示词粘贴给它即可。

## Quick start

Requires Node 22.18+, Bun (browser build) and the CLIs you want to watch, already logged in.

```sh
git clone https://github.com/brezzashen/token-arcade.git
cd token-arcade
npm ci
npm run build
npm start            # http://127.0.0.1:8047
```

To let a coding agent install it for you, paste the prompt in [AGENT_SETUP.md](AGENT_SETUP.md).
For Docker, see [deploy/DOCKER.md](deploy/DOCKER.md).

## Accounts

Accounts use fixed aliases. Unset `TOKEN_ACCOUNTS` reads `cc1,co1`.

| Alias | Source |
| --- | --- |
| `cc1` | Claude Code default login (`~/.claude`) |
| `cc2`–`cc7` | Extra Claude Code profiles: the names in `TOKEN_CLAUDE_PROFILES`, else the first six sub-directories of `~/.claude-profiles` in name order (each used as `CLAUDE_CONFIG_DIR`) |
| `co1` | Codex default login (`~/.codex`) |
| `co2` | One extra Codex profile: `TOKEN_CODEX_PROFILES`, else the first sub-directory of `~/.codex-profiles` (used as `CODEX_HOME`) |
| `grok` | Grok CLI login (`~/.grok`) |
| `ag1`, `ag2` | Antigravity CLI: `ag1` subscription, `ag2` Vertex AI pay-as-you-go |

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOKEN_ACCOUNTS` | `cc1,co1` | Comma-separated aliases to show |
| `TOKEN_CLAUDE_PROFILES` | auto | Profile directory names under `~/.claude-profiles` for `cc2`–`cc7` |
| `TOKEN_CODEX_PROFILES` | auto | Profile directory name under `~/.codex-profiles` for `co2` |
| `TOKEN_HOST` / `TOKEN_PORT` | `127.0.0.1` / `8047` | Listen address and port |
| `TOKEN_RANGE_SCRIPT` | `vendor/remaining-range/range.ts` | Quota reader script |
| `TOKEN_QUOTA_CACHE` | `~/.local/share/token-dashboard/state/last-quota.json` | Last successful quota per account |
| `TOKEN_REMOTE_HOSTS` | empty | Remote host panels, `win` and/or `mbp` (see below) |
| `TOKEN_VERTEX_PROJECT` | unset | Label for the `ag2` Vertex AI project |
| `TOKEN_SPEED_FALLBACK` | `0` | `1` allows hourly paid speed probes; leave it off |

A missing or logged-out profile shows as unavailable with the login command to run.
On macOS, Claude credentials come from the Keychain entry Claude Code itself writes.

## Run as a macOS background service

```sh
bun install.ts [--accounts cc1,cc2,co1] [--host 127.0.0.1] [--label local.token-arcade]
```

It builds the package, copies it into an immutable release under `~/.local/share/token-dashboard`,
and registers a launchd agent (default label `local.token-arcade`) that restarts after failure.
Keep `--host 127.0.0.1` unless you put an authenticated reverse proxy in front: the page
has no login, so anyone who can reach the port can read your quota percentages.

## Remote hosts (optional)

`TOKEN_REMOTE_HOSTS=win,mbp` adds a panel per remote machine, reached with the SSH aliases
`win` (Windows, Node installed) and `mbp` (macOS) from your `~/.ssh/config`.
`bun install-agent.ts --hosts win,mbp` bundles `host-agent.ts`, copies it to
`%LOCALAPPDATA%\token-host-agent\host-agent.mjs` or `~/.local/share/token-host-agent/host-agent.mjs`,
checks its SHA-256 and prints one `--once` snapshot per host.
The server keeps one `ssh -T <alias>` stream per host and retries a closed stream after 5 s, doubling to 60 s.
The agent exits when SSH closes, so nothing stays resident on the remote and no port is opened.

## Endpoints

`GET /health` reports process and collector state without account data.
`GET /api/usage` returns sanitized readings and the next scheduled collection time.
`GET /api/speed` returns output-speed aggregates without message text, paths or identifiers.
Unknown token counters remain null. Quota failures preserve available local tokens.
Cached input and reasoning output are subsets; totals come from the owning script.
Provider percentages are separate. Local records are not account billing.

## Speed collector liveness

`task-watch.ts` stamps `progressAt` and `stage` each time the poll loop advances (discover, stat, read, checkpoint).
The worker heartbeat republishes readings only while the loop moved within 30 s (`pollLive`), so `/api/speed` turns
stale instead of repeating old numbers. After 120 s without progress (`pollStalled`) the worker writes a
`{ type: "stalled", stage }` line and exits; the supervisor logs `Speed collector poll loop stalled at <stage>` to
`process-error.log` and restarts it from the checkpoint. A card that falls back to an older window labels its model
`最近用过`, not `正在用`.

## Per-model quota estimate

The reader adds `cycleTokens.byModel` (one token window per model, with long-request counters at that model's own price
tier: 272K for GPT, 200K for Gemini, 100K for Claude Haiku 5.5). `web/quota-models.ts` renders `按模型估算额度` under the `周期内` view:
each model's API-equivalent cost and share of the used quota, and how many tokens the same window would hold on one
model alone. Quota burn = API-equivalent cost × a per-model burn factor. `calibrate` measures the factor from the
accounts' own windows: windows at least 95% on the dominant model give the dollars behind one point per window length,
and windows with at least a 30% share of another model give that model's factor (median of at least two windows; a
model without one uses a same-family factor or 1×, labelled `未校准`). Providers publish no formula, so these are
estimates. A model-scoped server window (the separate Fable weekly limit) is selectable as its own cycle.

## How readings are collected

The server reads quota profiles once every 60 seconds without model calls.
`collect.ts` runs `vendor/remaining-range/range.ts` once per account and calls its local
record readers through `rolling.ts`. Telemetry uses trailing 1/3/5/24-hour
intervals anchored to each report capture time. Token totals, cache ratios, hourly burn
and model totals use those intervals; quota cycles and forecasts keep their original intervals.
A local read or identity mismatch hides telemetry and preserves the separate quota result.
Grok has no local token source and keeps unavailable counters.

Antigravity splits into `ag1 · ultra` (Google AI Ultra subscription) and `ag2 · vertex`
(Vertex AI pay-as-you-go). Their collectors read Antigravity
`brain/*/.system_generated/logs/transcript.jsonl` files and `conversations/*.db` step metadata
(`ModelUsage.api_provider`), separating subscription steps (`GOOGLE_GEMINI`, `GOOGLE_EVERGREEN`)
from Vertex AI steps (`GOOGLE_VERTEX`, `ANTHROPIC_VERTEX`, `OPENAI_VERTEX`).
conversation and step. Input includes the separately reported cached input once.
`ag1 · ultra` quota comes from the official `agy -p /usage --output-format json` command
(with Vertex environment variables stripped), which must return `num_turns: 0`.
Gemini 5-hour and weekly buckets stay separate from the Claude/GPT model-group buckets.
`ag2 · vertex` calculates local month-to-date and 24-hour real USD billing from recorded
Vertex AI token usage and BigQuery-verified Vertex AI SKU unit prices.
Failed quota reads use the normal dated quota cache.
The speed worker reads completed response metadata from Antigravity 1.3.x SQLite
databases, routing subscription responses to `ag1` and Vertex AI responses to `ag2`.
It measures recorded output tokens from `created_at` through `finished_generating_at`,
including first-token wait and excluding tool execution.
The card labels this **whole-response speed**, not a pure streaming decoder rate.
Missing timing, model attribution, thinking splits and the unconfirmed monthly fee
remain unavailable. Old cg4 records no longer populate these accounts.
`quota-cache.ts` keeps each account's last successful quota projection in
`~/.local/share/token-dashboard/state/last-quota.json` (`TOKEN_QUOTA_CACHE` overrides it).
A failed read reuses the cached windows that have not reset yet and marks the account
`quotaSource: cached` with the reading time; a window is dropped at its own reset time.
Raw quota reports stay in memory. The public JSON projection omits transcript evidence,
local paths, thread IDs, credentials, and raw provider errors.


## Display boundaries

`web/format.ts` owns token units, timestamps, quota names and record-coverage badges.
The display uses dark surfaces, white panel headers and yellow quota accents.
Claude marks use orange plates (#d97757). Grok marks use black plates with white,
inverted logos. Provider plates stay consistent across the legend and account views.
Quota meters use Claude orange (#d97757) and monochrome white (#ffffff) for
Codex and Grok on dark surfaces, including low-quota cards.
`web/provider.ts` shares Claude, GPT / Codex and Grok marks across the legend,
account tables and selectors. Vendored SVG provenance and the MIT license are in
`web/logos/`; the server allows only the three named SVG image routes.
`web/overview.ts` renders every account's account-wide 300-minute limit, weekly limit,
Claude's independent `Fable 5` weekly model limit (`weekly_scoped` with `weekly_scoped_shares`,
refreshed from the server endpoint every 5 minutes even when statusline is active and merged
across statusline polls), and local 24-hour token totals in one compact table.
`web/weekly-logo.ts` renders weekly quota as square pixel plates derived from the
vendored Claude, OpenAI and Grok marks. Provider colors fill from the bottom, so
used quota grays the plate from the top down; 100% colors the full plate and 0% leaves it gray. The exact percentage appears below
the logo. Missing readings remain unavailable; Grok keeps a gray pixel logo with
an em dash and no numeric progress value when its reading is unavailable.
`web/logos/pixels.ts` freezes the
pixel geometry; no browser image loading or canvas work is needed for these plates.
Selected-account details follow as section 02 (including the `周额度 · Fable 5` card and cycle tokens);
all-account current-cycle token consumption (including model-scoped cycles with local records) follows as section 03.
Missing 5-hour limits are explicit. Missing cycles fall back to labeled rolling 24-hour records.
Per-percentage-point and full-window estimates come from the skill's cycle fields;
they describe the observed local workload, never an official token allowance.
`web/sections.ts` renders overlapping interval comparisons, cycle totals and the
skill's four forecast samples with calibration reasons and actual sample intervals.
`web/app.ts` owns selection, local display preferences, connection recovery,
countdown and page synchronization. The synchronization button reads the shared
snapshot; it never starts another provider query. Account/interval preferences
store only selector names. No usage readings are saved by the browser.

`web/telemetry.ts` adds a current-cycle selector to the rolling telemetry tabs.
It defaults to the account-wide weekly window, allows other account-wide reset
windows, and excludes expired and model-scoped windows. Cumulative tokens come
from the existing cycle projection, from the last reset through report capture.
The page shows used quota, both reset boundaries and the cumulative capture time.
Cycle cache hit rate uses cached input divided by total input; hourly burn uses
elapsed time since reset. Missing local usage stays unavailable, including Grok.


## Official price reference

`web/pricing.ts` records official standard API prices checked on 2026-11-11:
[Claude](https://platform.claude.com/docs/en/about-claude/pricing),
[OpenAI](https://developers.openai.com/api/docs/pricing),
[Gemini](https://ai.google.dev/gemini-api/docs/pricing), and
[Grok](https://docs.x.ai/developers/pricing). Each model row links its source.
Exact model aliases and dated suffixes resolve only to verified rate entries.
Unknown models and missing counters remain unavailable rather than inheriting a rate.

Section 04 follows all-account consumption. It shows input, cache read, cache write,
output and cache-read price ratios, plus per-account/model rolling 24-hour equivalents.
Input already includes cache read and write. The calculator subtracts those subsets
before charging ordinary input, and charges output once. The no-cache baseline
charges all input at ordinary rates. Discount means cached cost divided by that baseline.
Claude cache TTL and GPT context splits are absent from aggregate counters, so their
standard-rate equivalents and discounts show scenario ranges rather than false precision.
Fast, Batch, regional uplifts, tool fees and subscription payments are outside this estimate.
Grok Build rates are a reference model, not an attribution of missing local usage.
The price check date is a snapshot; prices do not refresh with minute usage collection.

Validate the price calculator with
`node --disable-warning=ExperimentalWarning --test web/pricing.test.ts`, or run every test with `npm test`.

## Output-speed collection

The first screen has one card per local account (`cc1`, `cc2`, `cc3`, `cc4`, `cc5`, `cc6`, `cc7`, `co1`, `co2` in registry order, from the
worker's `accounts` list; Grok has no local records). Each card follows the model that account answered with most
recently and shows its reasoning and visible-output speeds as separate large values, followed by the combined
rolling one-hour mean and requested mode. Codex cards compare Ultrafast, Fast and Standard separately and mark
the current mode. Other models the account used in the hour are listed below; an
account without recent conversations keeps an explicit empty card.
`task-watch.ts` discovers selected-profile conversations updated within seven days, not only the current conversation.
It tails files every two seconds and discovers new files every 16 seconds without provider requests.
Codex records require matching creator accounts. Message and response IDs deduplicate replayed files per account.

`task-output.ts` tokenizes visible AgentMessage text with `o200k_base` and uses explicit item start/end times.
Reasoning uses response `usage.reasoning_output_tokens`, paired with timed Reasoning items since the preceding
usage record in the same turn. Overlapping reasoning intervals are unioned within that response.
Hidden reasoning text and summaries are never used to infer a hidden token count.
Missing reasoning counts or explicit timing are unavailable, not zero.
Claude yields one sample per response: `usage.output_tokens` (thinking, text and tool input) over the span from the
leading thinking block's start (record timestamp minus `thinkingDurationMs`, which excludes time to first token) to
the response's last block record. Interactive Claude Code stretches `thinkingDurationMs` over text generation and
writes text records in a burst, so thinking and text cannot be timed apart; the card shows the whole-response rate
and responses without a timed leading thinking block are excluded. Tool text, tool wait time and user-to-reply elapsed time are excluded.
Logged reasoning intervals describe recorded reasoning activity, not guaranteed pure token-compute latency.

`dialog-speed.ts` isolates accounts, models and modes and removes records older than seven days on every heartbeat.
It calculates overlapping 1/3/5/24-hour and 3/7-day windows using the same capture time. A complete generation segment must
start and finish inside its window; cross-boundary segments are excluded rather than proportionally estimated.
Short-window reads preserve the older records needed by longer windows. `web/interval-speed.ts` renders the
selected account's window, model and mode comparisons above the existing workload-consumption comparison.
The independent history panel below the current cards switches between the past hour, three days and seven days.
It filters by account and model using selectors with provider logos, and lists reasoning, output and combined
rates per model and mode, with sample counts and the most recent sample time. The selected history window,
account and model persist in the browser. On restart, the
worker backfills the available local transcripts; missing history is never invented or treated as zero.
It sums eligible tokens and eligible segment durations, then divides those sums; it never averages individual
token/s values. Concurrent conversations contribute their own segment durations rather than an account-wide
wall-clock union. The combined mean includes measured reasoning and estimated visible-text segments.
Separate reasoning and text means, valid segment counts, conversation counts and excluded records show coverage.
If reasoning is unavailable, the card labels its rate as text only. Aggregate rates remain approximate.
Codex mode comes from explicit service-tier settings; tierless turn contexts preserve prior settings.
Requested mode is configuration, not proof of the served tier. Unknown modes stay unknown.

Automatic fallback is disabled by default. `install.ts` pins `TOKEN_SPEED_FALLBACK=0` in the local LaunchAgent.
`speed-worker.ts` only permits probes with an explicit `TOKEN_SPEED_FALLBACK=1`; no installation enables it.
While disabled, no benchmark process starts, prior benchmark samples are hidden, and nextFallbackAt is null.
The dormant probe and hourly scheduling receipt are retained for a future explicitly requested benchmark.
If enabled, only a Standard cohort without usable conversation measurements receives an hourly serial probe.
Calls consume allowance and remain bounded to 90 seconds without retries.

Private compressed checkpoints retain source-validated offsets, parser state and measured segments without transcript text.
Restarts resume unchanged files; changed ownership or replaced sources trigger a fresh read. Fallback aggregates and their schedule retain their separate policy. Public aggregates contain no text, file paths, message IDs or conversation IDs.
Disconnected readings hide their speed. The browser refreshes averages without starting provider calls.

Run `npm test` for weighted averaging, expiry, account/mode isolation, response reasoning arithmetic,
deduplication, missing timing, public privacy, stale rendering and existing price calculations.
