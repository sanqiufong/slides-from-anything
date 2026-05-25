# open-design Companion Protocol · v1

This document is the single source of truth for how **open-ppt** and **design-vault** discover, launch, and hand off to each other. Both repos ship a byte-identical copy of this file. Changes to the protocol require updating both copies in the same release.

> Versioning: spec strings carry a `@vN` suffix. Consumers that don't understand a newer major version MUST refuse the handshake gracefully and tell the user to upgrade — never silently downgrade behavior.

---

## 1. Components

| Role | Project | Default origin | Surface |
|------|---------|----------------|---------|
| **Vault** (authoring station) | `design-vault` (Next.js) | `http://127.0.0.1:3217` | REST `/api/*`, root page `/` |
| **Host** (consumer) | `open-ppt` (daemon + web) | daemon on user-chosen port | `/api/vault/*` proxy, web UI |

The Vault is optional. The Host MUST work without it (falling back to its embedded snapshot), but SHOULD offer install/launch guidance when the user wants to author new templates.

---

## 2. Registry File

Both projects share a JSON file on disk so the Host can discover whether the Vault is installed even when it isn't currently running.

**Path resolution:**

1. If `$XDG_CONFIG_HOME` is set: `$XDG_CONFIG_HOME/open-design/registry.json`
2. Otherwise: `~/.config/open-design/registry.json`

**Shape:**

```json
{
  "spec": "open-design/registry@v1",
  "apps": {
    "design-vault": {
      "baseUrl": "http://127.0.0.1:3217",
      "version": "0.1.0",
      "port": 3217,
      "pid": 12345,
      "lastSeen": "2026-05-16T08:00:00Z",
      "spec": "open-design/vault@v1",
      "capabilities": [
        "ingest:url",
        "ingest:clone-website",
        "ingest:design-system-project",
        "ingest:canva-template",
        "ingest:canva-editor"
      ]
    }
  }
}
```

**Write rules:**

- The Vault MUST write this file on startup (via `predev`/`prestart` script) with `pid: null`.
- The Vault's running process MUST then overwrite the entry with its real `pid` and refresh `lastSeen` every ~30 seconds.
- On graceful shutdown the Vault SHOULD set its own `pid` back to `null` (best-effort).
- Writers MUST preserve unrelated app entries — read-modify-write the whole `apps` map.
- Writes SHOULD be atomic (write `tmp` then `rename`).

**Read rules:**

- The Host MAY read this file at any time, but MUST NOT cache the result for longer than the next user-initiated action.
- An entry whose `lastSeen` is older than **90 seconds** AND whose `/api/health` probe fails is considered "installed but not running".
- The Host MUST verify the live state with `/api/health` before trusting the registry's `baseUrl` for navigation.

---

## 3. Vault Health Endpoint

`GET {baseUrl}/api/health` — no auth, no rate limit. Cache: `no-store`.

```json
{
  "ok": true,
  "service": "design-vault",
  "spec": "open-design/vault@v1",
  "version": "0.1.0",
  "capabilities": [
    "ingest:url",
    "ingest:clone-website",
    "ingest:design-system-project",
    "ingest:canva-template",
    "ingest:canva-editor"
  ],
  "designCount": 125
}
```

The Host MUST treat any non-2xx response, or any response missing `ok: true` and `service: "design-vault"`, as "not running".

Recommended probe timeout: **800 ms**.

---

## 4. Deep-link Protocol (Host → Vault)

When the Host wants the user to add or browse templates in the Vault, it navigates the user to the Vault root URL with these query parameters:

| Param | Required | Purpose |
|-------|----------|---------|
| `source` | yes | Identifier of the host app, e.g. `open-ppt`. |
| `return_to` | yes | Absolute URL to redirect to on success. **Must** be `http(s)://127.0.0.1:*` or `http(s)://localhost:*`. |
| `intent` | no | `create` (open ingest form immediately) or `browse` (default). |
| `prefill_url` | no | URL to prefill into the ingest form's source field. Only honored with `intent=create`. |

**Example:**

```
http://127.0.0.1:3217/?source=open-ppt&intent=create&prefill_url=https%3A%2F%2Flinear.app&return_to=http%3A%2F%2F127.0.0.1%3A3216%2Flibrary
```

**Vault behavior:**

- The Vault MUST render a banner ("来自 open-ppt · 完成后将自动返回") whenever `source` + `return_to` are present.
- The Vault MUST validate `return_to` against the allowed-hosts list (loopback only). Invalid `return_to` SHALL be rejected with a visible error and no redirect.
- The Vault MAY persist these params to session storage so they survive in-app navigation.
- The user MUST be able to cancel and return without completing an import (the banner provides a "取消并返回" button).

---

## 5. Return Protocol (Vault → Host)

When an ingest job submitted **after** a deep-link arrival completes successfully, the Vault redirects the browser to:

```
{return_to}?imported={slug}&from=design-vault
```

The Host's library page accepts:

| Param | Effect |
|-------|--------|
| `imported` | Slug of the newly imported template. Host SHOULD refresh its catalog, scroll/highlight that card, and show a confirmation toast. |
| `from` | Always `design-vault` for v1. Reserved for multi-vault future. |

The Host MUST `router.replace` away the query params after consuming them so a refresh doesn't re-trigger the toast.

If a job *fails*, the Vault MUST NOT redirect — the user stays on the Vault to inspect the error.

---

## 6. Install Bootstrap (Host's responsibility)

When the Host detects "not installed" (no registry entry) or "installed but not running" (stale registry + failed probe), it SHOULD present the user with copy-pasteable shell commands. The Host MUST NOT auto-execute install commands.

Recommended copy:

- **Not installed**: `git clone <git-clone-url> ~/project/design-vault && cd ~/project/design-vault && pnpm install && pnpm dev`
- **Installed but not running**: `cd ~/project/design-vault && pnpm dev`

After showing the commands, the Host SHOULD poll `/api/vault/discovery` (or directly poll registry + health) every 2 seconds (max 5 minutes) until the Vault is running, then automatically continue the deep-link flow.

---

## 7. Versioning & Backward Compatibility

- Breaking changes bump the major version in the `spec` string (`open-design/vault@v2`).
- The Host SHOULD check `health.spec` and refuse to deep-link to a Vault whose major version differs from what it understands.
- Both repos MUST ship the updated `SPEC.md` in the same release. CI on either side MAY assert that the two files are byte-identical.

---

## 8. Security Notes

- `return_to` is the only attacker-controllable string in this protocol. Vault implementations MUST enforce the loopback host whitelist. Any non-loopback `return_to` MUST be rejected without prompting the user.
- The registry file lives in the user's home dir; treat it as trusted only for **discovery**, never for authentication. Both sides MUST still hit `/api/health` to confirm the Vault is alive and on the expected spec.
- Neither side SHOULD pass secrets through query parameters. Tokens or API keys belong in request bodies sent to the daemon over loopback only.
