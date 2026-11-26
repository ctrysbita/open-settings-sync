# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-27

### Changed

- Extension sync now propagates removals in both directions after the first sync. The review lists local uninstalls and IDs to remove from Git before applying them.
- The preview tab now offers **Apply Sync** and **Cancel Sync**. Closing the last tab for that preview cancels the sync.

### Fixed

- Fixed Configure and Sync Now failing to read the active profile's user settings when another file had focus.

### Removed

- Removed the **Open Settings Sync: Show Log** command. To view the log, select **Open Settings Sync** in the Output panel.

## [0.0.1] - 2026-11-26

### Added

- Manual Git-backed synchronization for portable user settings and user-installed extensions across VS Code and Cursor desktop profiles.
- Three-way settings merge with interactive conflict resolution and read-only diff preview.
- Order- and comment-preserving JSONC patching for top-level settings, nested objects, and arrays.
- Isolated bare Git repository cache storing snapshots at `.settings-sync/<collection>.json` with `--force-with-lease` protection.
- Automatic local settings backups with retention limits and one-click restore (`Open Settings Sync: Restore Settings Backup`).
- Cross-window locking and stage-by-stage progress notifications.
