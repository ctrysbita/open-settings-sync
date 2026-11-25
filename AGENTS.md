# AGENTS.md

A desktop VS Code / Cursor extension that syncs user settings and user-installed
extensions through Git. Keep the core independent from editor and Git APIs.

- An implementation request authorizes edits and necessary validation. Commits, pushes,
  publishing, and installation into a real editor profile require explicit instructions.
- Organize by feature. `src/sync` is pure logic with no Node.js or VS Code imports;
  `src/git` and `src/storage` implement IO; `src/editor` adapts VS Code; `extension.ts`
  assembles the application. Dependencies point toward the pure core.
- Keep the surface small: no speculative interfaces, unused options, or placeholder features.
  Export only what another module needs. Document exported contracts and failure behavior.
- Treat external data as unknown until validated. Preserve error causes and structured
  error codes. Reject unsupported schemas and unsafe operations explicitly.
- Never read or write the editor's SQLite databases or credential stores. Keep built-in
  extension enablement, editor-managed credentials, and undocumented UI state local.
  For ordinary user settings, exclusions for credential-like names and nested keys belong
  in `openSettingsSync.ignoredSettings`.
- Use argument arrays without a shell for child processes. Bound subprocess execution;
  terminate children when cancelled. Do not log settings values or credentials.
- Keep tests deterministic and parallel-safe. Name tests after observable guarantees.
  Use temporary local Git repositories for integration tests; do not contact user remotes.
- Editor-host tests must use fresh user-data and extensions directories, disable updates,
  and verify temporary source paths before changing settings or installing test VSIX files.
- Declare direct dependencies, keep the lockfile, and treat lint/type errors as failures.
  Run `npm run check` and `npm run package` before handing off extension changes.
- Follow Conventional Commits if committing is requested. Report changes, validation,
  and any checks that could not run.
