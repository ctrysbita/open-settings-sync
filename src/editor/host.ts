/** The editor owns all writes to its settings document and installation lifecycle. */
import * as vscode from "vscode";
import type { SettingsSource } from "../storage/files";
import { SyncFailure } from "../sync/failure";
import type { SettingChange } from "../sync/merge";
import { isInternalExtensionId } from "../sync/policy";
import type { LocalState } from "../sync/session";
import { isValidExtensionId, type Settings } from "../sync/snapshot";
import { installedExtensions, installInProfile, type InventoryOptions } from "./inventory";
import { parseSettings, patchSettings } from "./settings-document";
import { openUserSettings } from "./source";

/** No setting is changed if the reviewed document has been edited or left unsaved. */
export class EditorHost {
  private readonly cli: InventoryOptions;
  constructor(
    private readonly source: SettingsSource,
    private readonly builtin: ReadonlySet<string>,
    private readonly signal: AbortSignal,
  ) {
    this.cli = { executable: process.execPath, appRoot: vscode.env.appRoot, source, signal };
  }

  /** Backup restoration is independent of extension inventory availability. */
  async settingsText(): Promise<string> {
    return (await this.document()).getText();
  }

  /** Lightweight verification path when a sync modifies settings without installing extensions. */
  async readSettings(): Promise<Settings> {
    return parseSettings(await this.settingsText());
  }

  async read(): Promise<LocalState> {
    const document = await this.document();
    const text = document.getText();
    const extensions = await installedExtensions(this.cli);
    if (document.isDirty || document.getText() !== text) {
      throw new SyncFailure("local-changed", "Save your settings and run Sync Now again.");
    }
    return {
      settingsText: text,
      snapshot: { version: 1, settings: parseSettings(text), extensions },
    };
  }

  /** Defends the installation boundary even if a caller bypasses merge policy. */
  async installExtension(id: string): Promise<void> {
    if (
      !isValidExtensionId(id) ||
      this.builtin.has(id.toLowerCase()) ||
      isInternalExtensionId(id)
    ) {
      throw new SyncFailure(
        "invalid-data",
        "Refusing to install an internal or invalid extension.",
      );
    }
    this.signal.throwIfAborted();
    await installInProfile(this.cli, id);
  }

  async applySettings(
    expectedText: string,
    changes: readonly SettingChange[],
    order?: readonly string[],
  ): Promise<void> {
    await this.replace(expectedText, patchSettings(expectedText, changes, order));
  }

  /** Used for an explicitly reviewed backup restore; it uses the same concurrency guard. */
  async replace(expectedText: string, nextText: string): Promise<void> {
    this.signal.throwIfAborted();
    parseSettings(nextText);
    const document = await this.document();
    if (document.getText() !== expectedText) {
      throw new SyncFailure("local-changed", "The settings file changed. Review it and retry.");
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(expectedText.length)),
      nextText,
    );
    if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save())) {
      throw new SyncFailure(
        "process-failed",
        "Could not save settings. Changes may remain in the editor; review them before retrying.",
      );
    }
  }

  private async document(): Promise<vscode.TextDocument> {
    this.signal.throwIfAborted();
    const document = await openUserSettings();
    if (document.uri.toString() !== this.source.uri)
      throw new SyncFailure(
        "local-changed",
        "The active editor profile changed. Run the command again.",
      );
    return document;
  }
}
