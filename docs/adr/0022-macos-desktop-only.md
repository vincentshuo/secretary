# Deliver Edison only as a macOS desktop application

**Status: accepted (2026-11-23).** Supersedes ADR 0013 and restores the desktop delivery of ADR 0001 and ADR 0011.

The self-hosted web instance existed so the YouTube workbench could run around the clock. That pipeline now runs as a Mac watcher that publishes to GitHub Pages, so the only work that still needs a server is the continuous classroom archive. Personal features such as the body profile need local-only data, a full Python runtime and models that do not fit a 2.5 GB host. The owner therefore retires the web instance and ships Edison only as the Tauri 2 desktop shell with its frozen Python sidecar.

Delivery follows ADR 0011: the app is built locally for Apple Silicon on macOS 14 or later, uses ad-hoc signing, and has no notarisation or auto-update. The sidecar's state directory (`~/.config/edison`) is the single home of user data, and no memory ceiling applies to optional components.

## Consequences

- The classroom archive moves from the server's systemd timer to a schedule on the Mac. Server state is migrated back, and server-only code (web login, web origin allowance, server-to-Mac backup) is removed. This work is tracked separately and does not block new desktop features.
- ADR 0017 and ADR 0018 assumed a server content session that was never built. Edison no longer acquires YouTube content, so both are superseded.
- Personal data may stay on the machine: a desktop feature should not need a login session or a network round trip.

## Amendment (2026-11-25)

The YouTube reading library now runs entirely on the Mac. The writing agent delivers unique HTML files into the existing channel directories. The desktop application watches those directories while running and scans them again on launch. This retires the publishing watcher, the Pages site and its public article links.
