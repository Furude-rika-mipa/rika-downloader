# Agent operating contract

This directory is the source of truth for a local Windows video downloader. Read this directory's `README.md` before making changes.

## Collection layout

- This directory is the standalone Windows application root. Keep source, documentation, and configuration together. Tests are retained locally and excluded from the repository.
- Preserve the original copyright and license in `LICENSE` and third-party notices.
- Releases contain reviewed source and launchers. Third-party binaries may only be redistributed after completing their own licensing and corresponding-source requirements.
- Never commit `.env` files, credentials, personal configuration, browser profiles, cookies, runtime binaries or generated media. Maintain the tool-local `.gitignore`.

## Supported target

- Primary target: Windows 10/11, 64-bit.
- The app is local-only and must listen on `127.0.0.1`, never `0.0.0.0`.
- There are no npm dependencies. Runtime tools are reconstructed by `scripts/bootstrap-windows.ps1`.

## Required invariants

1. Never commit `bin/`, `config.json`, browser profiles, cookies, downloaded media, or temporary files.
2. The user authorized automatic browser-session use for supported sites and persistent Windows-user-protected, per-site cookie caching. Never print, commit, or upload cookies to the software author. Preserve existing cache when refresh fails.
3. Do not expand cookie collection beyond the requested site's required domains. Respect browser access restrictions.
4. Preserve public fallbacks, including Douyin's isolated guest path.
5. A completed download must contain both a video stream and an audio stream. Keep the FFmpeg validation.
6. Preserve safe URL argument separation (`--`, then URL), filename limits, loopback binding, bounded job history, and asynchronous folder selection.
7. User-specific state belongs in ignored `config.json`. The source default is `%USERPROFILE%\Downloads\视频素材`.
8. Loopback is not authentication. Preserve the loopback Host allowlist, per-process POST token, same-origin checks, 64 KiB JSON limit, security headers, and server-side job-ID lookup for Explorer actions.
9. Every downloaded executable must have an immutable version and repository-pinned SHA-256. A mirror may transport bytes but must never provide the trusted checksum at runtime.

## Windows setup

For installation, follow `docs/INSTALL.md` and use `scripts/install-windows.ps1 -Json`. Honor the receiving user's install-location preferences and choose a writable directory. Do not run `npm install`, change global execution policy, or copy another person's configuration.

Installation is complete only after the returned `ok`, `started`, build, instance, and component readiness match the actual local service. Never assume port 3210 or reuse a different installation directory. Use `-NoStart` only when startup is not requested.

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1
```

Then start with `梨花下载器.exe`, or build and launch it with `scripts/build-desktop.ps1 -Launch` if it is missing.

## Validation

Before handing off a change, run targeted checks appropriate to the affected functionality. Respect the user preference not to perform hash verification.

For network-dependent download changes, additionally test one current, public, authorized video URL for each affected site. Confirm the final file has both video and audio. Do not commit test URLs that contain personal tokens.

## Distribution

- Source repositories exclude runtimes via `.gitignore`.
- Portable binaries belong in a GitHub Release ZIP, not Git history.
- Update `dependencies.windows.json`, its SHA-256 values, README, locally available tests, and `THIRD_PARTY_NOTICES.md` when changing dependencies.
- Never use mutable dependency URLs such as `releases/latest`, and verify an existing `bin` executable before running even a version probe.
