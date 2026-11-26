/** The editor owns all writes to its settings document and installation lifecycle. */
import * as vscode from "vscode";
import type { SettingsSource } from "../storage/files";
import { SyncFailure } from "../sync/failure";
import type { SettingChange } from "../sync/merge";
import { isInternalExtensionId } from "../sync/policy";
import type { LocalState } from "../sync/session";
import { isValidExtensionId, type Settings } from "../sync/snapshot";
import {
  installedExtensions,
  installInProfile,
  type InventoryOptions,
  uninstallInProfile,
} from "./inventory";
import { parseSettings, patchSettings } from "./settings-document";
import { openUserSettings } from "./source";

/** No setting is changed if the reviewed document has been edited or left unsaved. */
export class EditorHost {
  private readonly cli: InventoryOptions;
  constructor(
    private readonly source: SettingsSource,
    private readonly protectedExtensions: ReadonlySet<string>,
    private readonly signal: AbortSignal,
    private readonly manifests: readonly unknown[] = [],
  ) {
    this.cli = { executable: process.execPath, appRoot: vscode.env.appRoot, source, signal };
  }

  /** Backup restoration is independent of extension inventory availability. */
  async settingsText(): Promise<string> {
    return (await this.document()).getText();
  }

  /** Lightweight verification path when a sync only modifies settings. */
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

  async installExtension(id: string): Promise<void> {
    this.assertUserExtension(id);
    await installInProfile(this.cli, id);
  }

  /** Refuses to cascade an uninstall into extensions outside the reviewed plan. */
  async uninstallExtension(id: string, approved: ReadonlySet<string>): Promise<void> {
    this.assertUserExtension(id);
    const allowed = new Set(
      [...approved].filter((item) => this.isUserExtension(item)).map((item) => item.toLowerCase()),
    );
    await uninstallInProfile(this.cli, id, allowed, this.manifests);
  }

  private assertUserExtension(id: string): void {
    if (!this.isUserExtension(id)) {
      throw new SyncFailure("invalid-data", "Refusing to modify a protected or invalid extension.");
    }
    this.signal.throwIfAborted();
  }

  private isUserExtension(id: string): boolean {
    return (
      isValidExtensionId(id) &&
      !this.protectedExtensions.has(id.toLowerCase()) &&
      !isInternalExtensionId(id)
    );
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
