# Docker viewer

```sh
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8047/health
```

Open http://127.0.0.1:8047. The port is bound to 127.0.0.1 only.

- The container reads your agent homes through read-only mounts listed in `compose.yaml`.
  Add the commented mounts for extra Claude/Codex profiles or Grok.
- Credentials are never copied into the image. Codex quota RPC runs against a temporary
  copy of `auth.json` because `codex app-server` needs a writable home (`deploy/codex-container.ts`).
- Linux containers cannot read the macOS Keychain. Claude accounts then need a
  `.credentials.json` file in the profile; otherwise they show as unavailable.
  On macOS, the native install (`bun install.ts`) reads the Keychain directly.
- Quota state survives restarts in Docker volumes. Automatic provider speed probes are disabled.

```sh
docker compose logs --tail 50
docker compose down
```
