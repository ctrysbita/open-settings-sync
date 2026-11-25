/** Binds the active window's user settings and the matching editor CLI profile. */
import { basename, dirname } from "node:path";
import * as vscode from "vscode";
import type { FileStore, SettingsSource } from "../storage/files";
import { SyncFailure } from "../sync/failure";

/** Opens the active profile's settings. A dirty or unsupported document cannot be used. */
export async function openUserSettings(): Promise<vscode.TextDocument> {
  await vscode.commands.executeCommand("workbench.action.openSettingsJson");
  const document = vscode.window.activeTextEditor?.document;
  if (
    !document ||
    !["file", "vscode-userdata"].includes(document.uri.scheme) ||
    basename(document.uri.fsPath) !== "settings.json"
  ) {
    throw new SyncFailure(
      "invalid-configuration",
      "Could not identify the current profile's User Settings (JSON).",
    );
  }
  if (document.isDirty)
    throw new SyncFailure("local-changed", "Save User Settings (JSON) and retry.");
  return document;
}

/** Resolves only bindings for this document. A shared settings file needs an explicit CLI profile. */
export async function activeSource(
  context: Pick<vscode.ExtensionContext, "extensionMode" | "extensionUri">,
  store: FileStore,
  mode: "configure" | "use",
): Promise<SettingsSource> {
  const { uri } = await openUserSettings();
  const folder = dirname(uri.fsPath);
  const dedicated = basename(folder).toLowerCase() !== "user";
  const userFolder = dedicated ? dirname(dirname(folder)) : folder;
  if (
    dedicated &&
    (basename(dirname(folder)) !== "profiles" || basename(userFolder).toLowerCase() !== "user")
  ) {
    throw new SyncFailure(
      "invalid-configuration",
      "The current settings file is outside the supported editor profile layout.",
    );
  }
  const saved = await store.sources(uri.toString());
  const unconfigured = "Run Open Settings Sync: Configure in this editor profile first.";
  if (mode === "use" && saved.length === 0)
    throw new SyncFailure("invalid-configuration", unconfigured);

  let editorProfile = dedicated ? (saved.at(-1)?.editorProfile ?? "") : "";
  const shared =
    !dedicated &&
    (saved.some((item) => item.editorProfile !== "") || (await hasNamedProfiles(uri)));
  if (shared && mode === "use") {
    const selected = await vscode.window.showQuickPick(
      saved.map((source) => ({
        label: source.editorProfile || "Default",
        name: source.editorProfile,
      })),
      {
        title: "Which editor profile is active in this window?",
        placeHolder: "Choose the active profile. If it is missing, run Configure in this window.",
        ignoreFocusOut: true,
      },
    );
    if (!selected) throw new SyncFailure("cancelled", "Profile selection cancelled.");
    editorProfile = selected.name;
  } else if (mode === "configure" && (dedicated || shared)) {
    const name = await vscode.window.showInputBox({
      title: "Open Settings Sync: current editor profile",
      prompt: shared
        ? "This settings file can be shared. Enter the active profile's exact display name, or leave blank for Default."
        : "Enter the active profile's exact display name for extension listing and installation.",
      value: editorProfile,
      ignoreFocusOut: true,
      validateInput: (value) =>
        dedicated && !value.trim() ? "Enter the current profile name." : undefined,
    });
    if (name === undefined) throw new SyncFailure("cancelled", "Profile selection cancelled.");
    editorProfile = name.trim();
  }
  if (
    mode === "use" &&
    ((dedicated && !editorProfile.trim()) ||
      !saved.some((item) => item.editorProfile === editorProfile))
  )
    throw new SyncFailure("invalid-configuration", unconfigured);
  return {
    uri: uri.toString(),
    userDataDirectory: dirname(userFolder),
    editorProfile,
    extensionsDirectory:
      context.extensionMode === vscode.ExtensionMode.Production
        ? dirname(context.extensionUri.fsPath)
        : "",
  };
}

async function hasNamedProfiles(defaultSettings: vscode.Uri): Promise<boolean> {
  const directory = vscode.Uri.joinPath(defaultSettings, "..", "profiles");
  try {
    const entries = await vscode.workspace.fs.readDirectory(directory);
    return entries.some(
      ([, type]) => (type & (vscode.FileType.Directory | vscode.FileType.SymbolicLink)) !== 0,
    );
  } catch (cause) {
    if (cause instanceof vscode.FileSystemError && cause.code === "FileNotFound") return false;
    throw new SyncFailure(
      "invalid-configuration",
      "Could not identify the editor profile directory.",
      { cause },
    );
  }
}
