/** Explicit setup binds synchronization to a user settings document and editor profile. */
import { basename, dirname } from "node:path";
import * as vscode from "vscode";
import { validateRemote } from "../git/repository";
import type { FileStore, SettingsSource } from "../storage/files";
import type { SettingChange } from "../sync/merge";
import { isValidBranchName, isValidProfileName } from "../sync/policy";
import { type Settings, setting } from "../sync/snapshot";
import { resolveConnection, resolveIgnoredPatterns } from "./configuration-resolver";
import { EditorHost } from "./host";
import { parseSettings } from "./settings-document";
import { activeSource } from "./source";

/** Only settings registered by this extension are read from the shared namespace. */
export interface Configuration {
  readonly remote: string;
  readonly branch: string;
  readonly profile: string;
  readonly ignoredSettings: readonly string[];
  readonly ignoredExtensions: readonly string[];
}

/** Combines default and current profile exclusions. Invalid lists abort sync before publication. */
export async function readConfiguration(source: SettingsSource): Promise<Configuration> {
  const { local, defaults, connection } = await profileConfiguration(source, "sync");
  validateRemote(connection.remote);
  return {
    ...connection,
    ignoredSettings: resolveIgnoredPatterns("openSettingsSync.ignoredSettings", defaults, local),
    ignoredExtensions: resolveIgnoredPatterns(
      "openSettingsSync.ignoredExtensions",
      defaults,
      local,
    ),
  };
}

/** Opens the editor's own Settings JSON command so paths are never guessed from a database. */
export async function configure(
  context: vscode.ExtensionContext,
  store: FileStore,
  signal: AbortSignal,
): Promise<void> {
  const selected = await activeSource(context, store, "configure");
  const { connection } = await profileConfiguration(selected, "configure");
  const remoteInput = await vscode.window.showInputBox({
    title: "Open Settings Sync: Git repository",
    prompt: "SSH or HTTPS Git URL. Uses your existing Git credentials.",
    value: connection.remote,
    ignoreFocusOut: true,
    validateInput(value) {
      try {
        validateRemote(value.trim());
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid Git URL.";
      }
    },
  });
  if (remoteInput === undefined) return;
  const branchInput = await vscode.window.showInputBox({
    title: "Open Settings Sync: branch",
    value: connection.branch,
    ignoreFocusOut: true,
    validateInput: (value) =>
      isValidBranchName(value.trim()) ? undefined : "Enter a Git branch name.",
  });
  if (branchInput === undefined) return;
  const profileInput = await vscode.window.showInputBox({
    title: "Open Settings Sync: shared collection",
    prompt: "Use the same collection on the machines you want to synchronize.",
    value: connection.profile,
    ignoreFocusOut: true,
    validateInput: (value) =>
      isValidProfileName(value.trim())
        ? undefined
        : "Use letters, numbers, _ or - (up to 64 characters).",
  });
  if (profileInput === undefined) return;
  const nextFields: readonly (readonly [string, string])[] = [
    ["openSettingsSync.git.remote", remoteInput.trim()],
    ["openSettingsSync.git.branch", branchInput.trim()],
    ["openSettingsSync.profile", profileInput.trim()],
  ];
  await store.exclusive(async (check) => {
    const host = new EditorHost(selected, new Set(), signal);
    const text = await host.settingsText();
    const before = parseSettings(text);
    const changes: SettingChange[] = [];
    for (const [key, value] of nextFields) {
      const previous = setting(before, key);
      if (previous !== value) changes.push({ key, before: previous, after: value });
    }
    check();
    signal.throwIfAborted();
    if (changes.length) {
      await store.backup(selected.uri, text);
      await host.applySettings(text, changes);
    }
    await store.saveSource(selected);
  });
  void vscode.window.showInformationMessage(
    "Git sync configured. Run Open Settings Sync: Sync Now to review the first sync.",
  );
}

async function profileConfiguration(source: SettingsSource, command: "sync" | "configure") {
  const uri = vscode.Uri.parse(source.uri);
  const local = parseSettings((await vscode.workspace.openTextDocument(uri)).getText());
  const inheritsConnection = !Object.hasOwn(local, "openSettingsSync.git.remote");
  let defaults: Settings = {};
  const hasDedicatedSettings = basename(dirname(uri.fsPath)).toLowerCase() !== "user";
  if (hasDedicatedSettings && (command === "sync" || inheritsConnection)) {
    const application = vscode.Uri.joinPath(uri, "..", "..", "..", "settings.json");
    try {
      defaults = parseSettings(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(application)),
      );
    } catch (cause) {
      if (!(cause instanceof vscode.FileSystemError && cause.code === "FileNotFound")) throw cause;
    }
  }
  return { local, defaults, connection: resolveConnection(local, defaults) };
}
