/** Profile-scoped CLI operations and manifest inventory, including disabled extensions. */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runProcess } from "../platform/process";
import type { SettingsSource } from "../storage/files";
import { SyncFailure } from "../sync/failure";
import { isRecord, isValidExtensionId } from "../sync/snapshot";

const extensionChangeTimeoutMs = 300_000;

/** The CLI entry comes from the running editor, never from the repository being synced. */
export interface InventoryOptions {
  readonly executable: string;
  readonly appRoot: string;
  readonly source: SettingsSource;
  readonly signal?: AbortSignal;
}

/** Uses argument arrays and the editor's supported CLI; never reads enablement databases. */
export async function installedExtensions(options: InventoryOptions): Promise<readonly string[]> {
  return [...(await installedExtensionVersions(options)).keys()].sort();
}

// Versions identify the active manifest when multiple releases share the extensions directory.
async function installedExtensionVersions(options: InventoryOptions): Promise<Map<string, string>> {
  const result = await profileCli(options, ["--list-extensions", "--show-versions"]);
  if (result.code !== 0)
    throw new SyncFailure(
      "process-failed",
      `Could not list extensions for this profile (exit ${result.code}). If it was renamed, run Configure again.`,
      { cause: new Error(result.stderr.trim() || result.stdout.trim()) },
    );
  const versions = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    const [id, version, extra] = entry.split("@");
    if (!id || !isValidExtensionId(id) || !version || extra !== undefined) {
      throw new SyncFailure(
        "invalid-data",
        "The editor CLI returned an unexpected extension inventory.",
        { cause: new Error(entry) },
      );
    }
    versions.set(id.toLowerCase(), version);
  }
  return versions;
}

/** Installs an admitted identifier or absolute local VSIX path into the same profile used for inventory. */
export async function installInProfile(
  options: InventoryOptions,
  extension: string,
): Promise<void> {
  const normalized = extension.toLowerCase();
  if (isValidExtensionId(extension)) {
    if (normalized.endsWith(".vsix"))
      throw new SyncFailure(
        "process-failed",
        `Install ${normalized} in the Extensions view. The editor CLI interprets this ID as a file path.`,
      );
    await changeInProfile(options, "install", normalized);
    return;
  }
  if (!isAbsolute(extension) || !normalized.endsWith(".vsix"))
    throw new SyncFailure("invalid-data", "Refusing to install an invalid extension.");
  await changeInProfile(options, "install", extension);
}

/** The CLI can uninstall an entire pack. Inspect installed members before admitting that command. */
export async function uninstallInProfile(
  options: InventoryOptions,
  id: string,
  approved: ReadonlySet<string>,
  manifests: readonly unknown[],
): Promise<void> {
  const target = id.toLowerCase();
  const approvedIds = new Set([...approved].map((item) => item.toLowerCase()));
  if (!isValidExtensionId(id) || !approvedIds.has(target))
    throw new SyncFailure("invalid-data", "Refusing to uninstall an unreviewed extension.");
  if (target.endsWith(".vsix"))
    throw new SyncFailure(
      "process-failed",
      `Uninstall ${target} in the Extensions view. The editor CLI interprets this ID as a file path.`,
    );
  const installed = await installedExtensionVersions(options);
  if (!installed.has(target)) return; // An earlier reviewed pack may already have removed it.
  const checked = new Set<string>();
  const pending = [target];
  for (const member of pending) {
    const version = installed.get(member);
    if (!version || checked.has(member)) continue;
    if (!approvedIds.has(member)) {
      throw new SyncFailure(
        "process-failed",
        `Removing ${target} would also uninstall ${member}, which is outside the sync plan.`,
      );
    }
    checked.add(member);
    const matches = manifests.filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) &&
        item.version === version &&
        typeof item.publisher === "string" &&
        typeof item.name === "string" &&
        `${item.publisher}.${item.name}`.toLowerCase() === member,
    );
    if (!matches.length)
      throw new SyncFailure(
        "process-failed",
        `Could not inspect the installed manifest for ${member}@${version} before uninstalling ${target}.`,
      );
    for (const manifest of matches) {
      if (manifest.extensionPack === undefined) continue;
      if (
        !Array.isArray(manifest.extensionPack) ||
        !manifest.extensionPack.every(
          (item): item is string => typeof item === "string" && isValidExtensionId(item),
        )
      )
        throw new SyncFailure(
          "process-failed",
          `Invalid extension pack in the manifest for ${member}.`,
        );
      pending.push(...manifest.extensionPack.map((item) => item.toLowerCase()));
    }
  }
  await changeInProfile(options, "uninstall", target);
}

async function changeInProfile(
  options: InventoryOptions,
  operation: "install" | "uninstall",
  extension: string,
) {
  const result = await profileCli(
    options,
    [`--${operation}-extension`, extension],
    extensionChangeTimeoutMs,
  );
  if (result.code !== 0)
    throw new SyncFailure(
      "process-failed",
      `Could not ${operation} ${extension} in the selected profile (exit ${result.code}).`,
      { cause: new Error(result.stderr.trim() || result.stdout.trim()) },
    );
}

function profileCli(options: InventoryOptions, command: string[], timeoutMs?: number) {
  const args = [
    join(options.appRoot, "out", "cli.js"),
    ...command,
    "--user-data-dir",
    options.source.userDataDirectory,
  ];
  if (options.source.editorProfile) args.push(`--profile=${options.source.editorProfile}`);
  if (options.source.extensionsDirectory)
    args.push("--extensions-dir", options.source.extensionsDirectory);
  return runProcess(options.executable, args, {
    signal: options.signal,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
}

/** Built-in provenance and machine scopes come from the shipped extension directory, including disabled entries. */
export async function builtinInventory(appRoot: string): Promise<{
  readonly extensions: readonly string[];
  readonly machineSettings: readonly string[];
}> {
  const manifests = await extensionManifests(join(appRoot, "extensions"), { strict: true });
  return {
    extensions: manifests.map((manifest) =>
      `${String(manifest.publisher ?? "undefined")}.${String(manifest.name)}`.toLowerCase(),
    ),
    machineSettings: machineSettings(manifests),
  };
}

/**
 * Includes disabled extensions, whose manifests may be absent from extensions.all.
 * Corrupted third-party manifests are skipped with an optional warning so they do not block sync.
 */
export async function userExtensionManifests(
  directory: string,
  onWarning?: (message: string) => void,
): Promise<readonly Record<string, unknown>[]> {
  return directory ? extensionManifests(directory, { strict: false, onWarning }) : [];
}

async function extensionManifests(
  directory: string,
  options: {
    readonly strict: boolean;
    readonly onWarning?: ((message: string) => void) | undefined;
  },
): Promise<readonly Record<string, unknown>[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
  const manifests: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let value: unknown;
    try {
      const raw = await readFile(join(directory, entry.name, "package.json"), "utf8");
      value = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      ) {
        continue;
      }
      if (!options.strict) {
        options.onWarning?.(
          `Skipped unreadable extension manifest (${entry.name}): ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        continue;
      }
      throw new SyncFailure(
        "invalid-data",
        `Could not inspect an installed extension manifest (${entry.name}).`,
        { cause },
      );
    }
    if (isRecord(value) && typeof value.name === "string") manifests.push(value);
  }
  return manifests;
}

/** Machine-scoped contributed settings remain local; other built-in paths have explicit policy rules. */
export function machineSettings(manifests: readonly unknown[]): readonly string[] {
  const result = new Set<string>();
  for (const manifest of manifests) {
    if (!isRecord(manifest) || !isRecord(manifest.contributes)) continue;
    const contribution: unknown = manifest.contributes.configuration;
    for (const section of Array.isArray(contribution) ? contribution : [contribution]) {
      if (!isRecord(section) || !isRecord(section.properties)) continue;
      for (const [key, schema] of Object.entries(section.properties)) {
        if (isRecord(schema) && ["machine", "machine-overridable"].includes(String(schema.scope)))
          result.add(key);
      }
    }
  }
  return [...result].sort();
}
