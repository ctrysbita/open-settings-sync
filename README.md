# Open Settings Sync

Synchronize portable user settings and user-installed extensions across **VS Code** and **Cursor** desktop installations using your own Git repository.

Open Settings Sync is manual-first and transparent: every synchronization shows a reviewable diff preview, prompts explicitly on conflicts, and takes a local backup before modifying your settings file.

## Features

- **Cross-editor sync**: Works identically across VS Code and Cursor desktop profiles without touching editor SQLite databases or credential stores.
- **Three-way settings merge**: Automatically merges independent edits, propagates deletions relative to the last successful sync, and prompts for interactive resolution on conflicting edits or order conflicts.
- **Order- and comment-preserving JSONC edits**: Keeps your local comments, formatting, trailing commas, key order, and ignored settings intact.
- **Additive extension sync**: Computes the union of user-installed extensions (including installed-but-disabled extensions), skips built-in extensions per editor, and never uninstalls local extensions.
- **Safe Git storage**: Uses an isolated bare Git cache with disabled hooks, updates only `.settings-sync/<collection>.json` without checking out repository trees, and enforces `--force-with-lease` on push.
- **Local backups & cross-window locking**: Saves up to 20 full local backups per settings file before editing, with one-click restoration and cross-window lock protection.

## Installation

1. Install **Git** and prepare a readable/writable Git repository using your existing SSH agent, `core.sshCommand`, or Git credential helper.
2. Install **Open Settings Sync** from the Visual Studio Marketplace (VS Code), Open VSX Registry (Cursor), or from a `.vsix` package via **Extensions -> Install from VSIX...**.

## Quick Start

1. Run **Open Settings Sync: Configure** (`openSettingsSync.configure`) and enter:
   - **Git repository**: SSH, HTTPS, SSH config alias (e.g. `github-work:owner/repo.git`), or absolute local repository path. Embedded credentials in URLs are rejected.
   - **Branch**: Target branch to sync (created automatically if the repository is empty or the branch does not yet exist).
   - **Shared collection**: Logical profile name stored at `.settings-sync/<collection>.json`. Use the same values across machines you want to sync together.
2. Run **Open Settings Sync: Configure** once per editor profile. Open Settings Sync opens the active profile's User Settings JSON to bind the source and uses the matching editor profile CLI to list and install extensions. Enter the exact display name for named profiles, or leave blank for the Default profile.
3. Run **Open Settings Sync: Sync Now** (`openSettingsSync.sync`):
   - Resolve any setting or key-order conflicts if prompted.
   - Choose **Preview** to inspect local setting changes, extension installations, and outgoing Git values. Choose **Apply Sync** or **Cancel Sync** at the top of the preview. Closing the preview also cancels the sync.

## Configuration

Extension settings live under `openSettingsSync.*` to stay completely separate from the editor's built-in `settingsSync.*` configuration, with storage-specific keys under `openSettingsSync.git.*`. Workspace settings cannot override them (`scope: "machine"`).

```jsonc
{
  "openSettingsSync.git.remote": "git@github.com:you/editor-settings.git",
  "openSettingsSync.git.branch": "main",
  "openSettingsSync.profile": "main",
  "openSettingsSync.ignoredSettings": [
    "workbench.colorTheme",
    "myExtension.machine*",
  ],
  "openSettingsSync.ignoredExtensions": ["company.private-extension"],
}
```

- **Profile inheritance**: Ignore lists from the Default profile apply to all named profiles and are merged with the current profile's own lists. Rules support case-insensitive `*` wildcards.
- **Per-profile connections**: Connection fields (`git.remote`, `git.branch`, `profile`) are stored in the current profile's `settings.json`. Named profiles without their own `openSettingsSync.git.remote` inherit connection settings from the Default profile until configured separately.

## Sync Rules

- **Settings merge**: Only values explicitly written to User Settings JSON participate. Each top-level setting (including objects, arrays, and language-specific blocks) is merged as a complete value against the local file, remote snapshot, and last successful baseline.
- **Deletions & missing collections**: Deletions propagate relative to the recorded baseline. On first sync, missing keys on either side are treated as unconfigured. If a previously synced branch or collection file disappears from Git, local settings are preserved and you can explicitly choose **Recreate on Git** after preview.
- **Extensions**: Takes the union of user-installed extensions and installs missing entries. Extension versions and enablement state stay local; local extensions are never uninstalled. If an extension cannot be installed (for example, it is unavailable in the target editor's marketplace), remaining extensions and local settings still finish syncing and a warning lists the skipped extensions so you can retry or add them to `openSettingsSync.ignoredExtensions`.
- **Built-in & machine-local exclusions**:
  - Built-in extensions (identified from the editor installation directory and internal prefixes) are never installed locally and remain untouched in Git for other editors that install them separately.
  - Sync settings (`openSettingsSync.*`, `settingsSync.*`, `syncSettings.*`), known terminal/interpreter/proxy paths, and extension settings with `machine` / `machine-overridable` scope are excluded automatically.
  - Ordinary user settings with credential-like names are **not** guessed or hidden automatically; exclude any sensitive setting name, nested key, or dotted path explicitly via `openSettingsSync.ignoredSettings` (e.g. `rest-client.defaultHeaders.X-API-Key` excludes the entire `rest-client.defaultHeaders` setting whenever that header is present).
- **Key ordering**: Git snapshots preserve written key order for top-level settings, nested objects, and objects inside arrays. Order-only changes are previewed and synced cleanly.
- **Failure & retry semantics**: Baselines advance only after Git publication and local settings writes succeed and verify, recording only verified extensions so any skipped extension installation stays pending until retried or ignored. Because Git push, local file writes, and extension installation cannot form a single atomic transaction, a local failure after push leaves Git updated; fix the local error and run **Sync Now** again.

## Backups & Recovery

Before modifying your settings file, Open Settings Sync stores a complete local copy (including comments and ignored settings) in the extension's `globalStorageUri` directory with private permissions (`0600`), retaining up to 20 backups per settings file.

- Run **Open Settings Sync: Restore Settings Backup** (`openSettingsSync.restore`) to restore any saved backup for the active settings file (the current file is backed up before restoring).
- Backups stay strictly local and are never uploaded to Git. Restoring settings does not roll back extension installations or Git history.
- After running an extension command, open **View → Output** and select **Open Settings Sync** from the channel dropdown to read the diagnostic log. Settings values and credentials are never logged.

## Development & Testing

Requires **Node.js 22+** and **Git**.

```sh
npm ci
npm run check
npm run package
```

- Press **F5** in VS Code or Cursor to launch an Extension Development Host. Synchronization never runs automatically on activation.
- `npm run check` runs Biome formatting and lint checks, strict TypeScript compilation, architectural boundary checks, unit tests, and local bare-Git integration tests (without touching any remote).
- Editor-host smoke tests run against a disposable temporary user-data and extensions directory with updates disabled:

```sh
npm run build
npm run compile:test
node scripts/smoke-editor.cjs "/path/to/editor-executable"
# Optionally test an isolated named profile:
node scripts/smoke-editor.cjs "/path/to/editor-executable" "Sync Test"
```

You can also set `VSCODE_SYNC_EDITOR` and run `npm run test:editor`.

## Architecture

- `src/sync/`: Pure protocol, filtering policy, three-way merge, and sync orchestration (zero Node.js or VS Code imports).
- `src/platform/`: Bounded, cancellable shell-free subprocess runner.
- `src/git/`: Isolated bare Git cache adapter and remote validation.
- `src/storage/`: Atomic file persistence, cross-window lockfile, baselines, and local backups.
- `src/editor/`: Editor profile discovery, JSONC patching/reordering, extension inventory CLI, configuration resolution, and interactive review UI.
- `src/extension.ts`: Activation lifecycle and dependency wiring.

## License

Licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) (see [LICENSE.md](./LICENSE.md)).
