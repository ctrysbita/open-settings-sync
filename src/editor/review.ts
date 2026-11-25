/** Conflict choices and a read-only preview of the exact admitted changes. */
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { Resolutions, SettingConflict } from "../sync/merge";
import type { SyncPlan } from "../sync/session";
import type { Json } from "../sync/snapshot";

/** Preview documents contain user data only in memory, never in logs or Git commits. */
export class Review implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly documents = new Map<string, string>();
  constructor(
    private readonly choose: (
      message: string,
      options: vscode.MessageOptions,
      ...actions: string[]
    ) => Thenable<string | undefined> = vscode.window.showInformationMessage,
  ) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.documents.clear();
  }

  /** Cancelling any conflict choice cancels the whole operation without writes. */
  async resolve(
    conflicts: readonly SettingConflict[],
    signal: AbortSignal,
  ): Promise<Resolutions | undefined> {
    const resolutions = new Map<string | null, "local" | "remote">();
    const total = conflicts.length;
    for (const [index, conflict] of conflicts.entries()) {
      if (signal.aborted) return undefined;
      const step = total > 1 ? ` (${index + 1}/${total})` : "";
      const selected = await pickOne(
        [
          {
            label: "Keep local",
            description: summarize(conflict, "local"),
            side: "local" as const,
          },
          { label: "Use Git", description: summarize(conflict, "remote"), side: "remote" as const },
        ],
        {
          title:
            conflict.key === null
              ? `Choose the order of shared settings${step}`
              : `Resolve setting${step}: ${conflict.key}`,
          placeholder:
            conflict.key === null
              ? "Choose which key order to keep. Escape cancels the sync."
              : "Both sides changed this setting. Escape cancels the sync.",
        },
        signal,
      );
      if (!selected) return undefined;
      resolutions.set(conflict.key, selected.side);
    }
    return resolutions;
  }

  async review(plan: SyncPlan, editorProfile: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const content = JSON.stringify(
      {
        editorProfile,
        settings: plan.settings.map((change) => ({
          key: change.key,
          before: represented(change.before),
          after: represented(change.after),
        })),
        settingsOrder: plan.settingsOrder,
        installExtensions: plan.installExtensions,
        updateGit: plan.upload,
        recreateCollection: plan.recreateCollection,
        gitSettings: plan.gitSettings.map((change) => ({
          key: change.key,
          before: represented(change.before),
          after: represented(change.after),
        })),
        gitSettingsOrder: plan.gitSettingsOrder,
        gitExtensions: plan.gitExtensions,
        keepLocal: { settings: plan.excludedSettings, extensions: plan.excludedExtensions },
      },
      null,
      2,
    );
    const uri = vscode.Uri.from({
      scheme: "open-settings-sync-preview",
      path: `/sync-${randomUUID()}.json`,
    });
    this.documents.set(uri.toString(), content);
    try {
      const action = plan.recreateCollection ? "Recreate on Git" : "Sync";
      const question = plan.recreateCollection
        ? "The previously synchronized Git collection is missing. Recreate it from this profile?"
        : "Apply this settings sync?";
      const detail =
        `Profile: ${editorProfile}. ${plan.settings.length} local setting changes, ${plan.installExtensions.length} extension installations.` +
        (plan.settingsOrder ? "\nReorder local settings." : "") +
        (plan.upload ? `\nUpload ${plan.gitSettings.length} setting changes to Git.` : "") +
        (plan.gitSettingsOrder ? "\nUpdate the setting order on Git." : "");
      const choice = await untilCancelled(
        this.choose(question, { modal: true, detail }, action, "Preview"),
        signal,
      );
      if (choice !== "Preview") return choice === action;
      signal.throwIfAborted();
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
        preview: true,
      });
      if (signal.aborted) return false;
      return (
        (await untilCancelled(
          this.choose(question, { modal: false }, action, "Cancel"),
          signal,
        )) === action
      );
    } finally {
      await closePreviewTabs(uri);
      this.documents.delete(uri.toString());
    }
  }
}

async function closePreviewTabs(uri: vscode.Uri): Promise<void> {
  const target = uri.toString();
  const matching: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups?.all ?? []) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === target) {
        matching.push(tab);
      }
    }
  }
  if (matching.length > 0) {
    await vscode.window.tabGroups.close(matching, true).then(
      () => undefined,
      () => undefined,
    );
  }
}

function pickOne<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: { readonly title: string; readonly placeholder: string },
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<T>();
    picker.items = items;
    picker.title = options.title;
    picker.placeholder = options.placeholder;
    picker.ignoreFocusOut = true;
    let chosen: T | undefined;
    const onAbort = (): void => picker.hide();
    signal.addEventListener("abort", onAbort, { once: true });
    picker.onDidAccept(() => {
      chosen = picker.selectedItems[0];
      picker.hide();
    });
    picker.onDidHide(() => {
      signal.removeEventListener("abort", onAbort);
      picker.dispose();
      resolve(signal.aborted ? undefined : chosen);
    });
    picker.show();
  });
}

function untilCancelled<T>(choice: Thenable<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  let cancel: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined);
    signal.addEventListener("abort", cancel, { once: true });
  });
  return Promise.race([choice, cancelled]).finally(() =>
    signal.removeEventListener("abort", cancel),
  );
}

function represented(value: Json | undefined): unknown {
  return value === undefined ? { present: false } : { present: true, value };
}

function summarize(conflict: SettingConflict, side: "local" | "remote"): string {
  if (conflict.key === null) {
    const first = conflict.local.findIndex((key, index) => key !== conflict.remote[index]);
    return `Position ${first + 1}: ${conflict[side].slice(first, first + 3).join(" → ")}`;
  }
  const value = conflict[side];
  return value === undefined ? "(deleted)" : JSON.stringify(value).slice(0, 160);
}
