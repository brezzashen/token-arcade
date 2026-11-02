# Agent setup prompt

Copy the block below into your coding agent (Claude Code, Codex or similar).
The agent installs Token Arcade on your machine and checks that it works.

```text
Install and configure Token Arcade from https://github.com/brezzashen/token-arcade on this machine.
It is a local dashboard for AI coding-agent quota and token usage. It reads the logins and
conversation records that Claude Code, Codex, Grok and Antigravity already keep on this machine.
It never calls a model. Follow these steps in order, report each result, and stop and ask me
if a step fails or a choice is unclear.

1. Prerequisites: `node -v` must be 22.18 or newer; `bun -v` (else use `npx -y bun`); `git --version`.
2. Clone into a directory I approve (default ~/token-arcade), then run `npm ci`.
3. Run `npm run build` (it must create web/dist/app.js) and `npm test` (all tests must pass).
4. Find the agent homes without reading any conversation content; only check that paths exist:
   - Claude Code: ~/.claude, plus sub-directories of ~/.claude-profiles (each one is a CLAUDE_CONFIG_DIR).
   - Codex: ~/.codex, plus sub-directories of ~/.codex-profiles (each one is a CODEX_HOME).
   - Grok: ~/.grok. Antigravity: ~/.gemini/antigravity-cli.
   Show me the list and ask which ones to watch.
5. Build the settings:
   - TOKEN_ACCOUNTS: aliases to show. cc1 = ~/.claude, cc2..cc5 = extra Claude profiles,
     co1 = ~/.codex, co2 = one extra Codex profile, grok, ag1 (Antigravity subscription), ag2 (Vertex AI).
   - TOKEN_CLAUDE_PROFILES / TOKEN_CODEX_PROFILES: profile directory names, in alias order,
     only if the alphabetical default order is not what I want.
6. Start it: `TOKEN_ACCOUNTS=... npm start` in the background. Wait 15 seconds, then
   `curl -s http://127.0.0.1:8047/health` must report "status":"ok" and
   `curl -s http://127.0.0.1:8047/api/usage` must list the chosen aliases.
   Tell me to open http://127.0.0.1:8047.
7. Optional, macOS only, if I want it to keep running after reboots:
   `bun install.ts --accounts <same aliases>`. Keep the default host 127.0.0.1;
   the page has no login, so never expose it on a public interface.
```
