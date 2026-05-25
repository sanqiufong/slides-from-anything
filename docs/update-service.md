# Update Service

The app starts from version `1.0.0` and exposes a read-only update check at
`/api/updates/check`.

The check is intentionally non-destructive:

- The daemon compares the current app version with a JSON manifest.
- The web UI shows the result in Settings -> About.
- Packaged users get a download or release link when the manifest provides one.
- Source users only get a prompt; local files are never overwritten.

## Manifest

By default the daemon reads `releases/stable.json`, which keeps local
development and tests deterministic. Production releases should set one of
these environment variables to a hosted manifest URL:

```bash
SFA_UPDATE_MANIFEST_URL=https://example.com/slides-from-anything/stable.json
OD_UPDATE_MANIFEST_URL=https://example.com/slides-from-anything/stable.json
```

Set `SFA_UPDATE_DISABLED=1` or `OD_UPDATE_DISABLED=1` to disable update checks.

Supported manifest shape:

```json
{
  "version": "1.0.1",
  "channel": "stable",
  "releasedAt": "2026-05-25T00:00:00.000Z",
  "notes": "Short release notes.",
  "releaseUrl": "https://github.com/example/slides-from-anything/releases/tag/v1.0.1",
  "assets": {
    "mac-arm64": {
      "url": "https://example.com/releases/slides-from-anything-mac-arm64.zip",
      "sha256": "optional-sha256",
      "size": 123456
    }
  }
}
```
