/** Desktop command wiring. Synchronization never runs automatically on activation. */
import { join } from "node:path";
import * as vscode from "vscode";
import { configure, readConfiguration } from "./editor/configuration";
import { EditorHost } from "./editor/host";
import {
  builtinInventory,
  machineSettings,
  machineSettingsFromDirectory,
} from "./editor/inventory";
import { Review } from "./editor/review";
import { activeSource } from "./editor/source";
import { GitRepository } from "./git/repository";
import { digest, FileStore } from "./storage/files";
import { SyncFailure } from "./sync/failure";
import { synchronize } from "./sync/session";
import { isRecord } from "./sync/snapshot";

/** Owns resources for the extension lifetime; all adapters are assembled here. */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Open Settings Sync", { log: true });
  const store = new FileStore(context.globalStorageUri.fsPath);
  const review = new Review();
  const running = new Set<AbortController>();
  context.subscriptions.push(
    output,
    review,
    vscode.workspace.registerTextDocumentContentProvider("open-settings-sync-preview", review),
    vscode.languages.registerCodeLensProvider({ scheme: "open-settings-sync-preview" }, review),
    vscode.commands.registerCommand("_openSettingsSync.applyPreview", (uri?: unknown) =>
      review.respondToPreview(true, uri),
    ),
    vscode.commands.registerCommand("_openSettingsSync.cancelPreview", (uri?: unknown) =>
      review.respondToPreview(false, uri),
    ),
    {
      dispose() {
        for (const controller of running) {
          controller.abort(new SyncFailure("cancelled", "Sync cancelled."));
        }
      },
    },
  );
  const register = (
    name: string,
    label: string,
    action: (signal: AbortSignal) => Promise<void>,
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(name, async () => {
        const controller = new AbortController();
        running.add(controller);
        try {
          await action(controller.signal);
        } catch (error) {
          if (
            controller.signal.aborted ||
            (error instanceof SyncFailure && error.code === "cancelled") ||
            (error instanceof Error && error.name === "AbortError")
          ) {
            output.info(`${label} cancelled.`);
            return;
          }
          const message = error instanceof Error ? error.message : "Unknown sync failure.";
          output.error(formatFailureForLog(error));
          void vscode.window.showErrorMessage(
            `${message} See Output → ${output.name} for details.`,
          );
        } finally {
          running.delete(controller);
        }
      }),
    );
  };

  const withProgress = <T>(
    signal: AbortSignal,
    task: (taskSignal: AbortSignal, progress: vscode.Progress<{ message?: string }>) => Promise<T>,
  ): Promise<T> =>
    Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Open Settings Sync",
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          const abort = (): void =>
            controller.abort(new SyncFailure("cancelled", "Sync cancelled."));
          if (signal.aborted) abort();
          signal.addEventListener("abort", abort, { once: true });
          const subscription = token.onCancellationRequested(abort);
          try {
            return await task(controller.signal, progress);
          } finally {
            signal.removeEventListener("abort", abort);
            subscription.dispose();
          }
        },
      ),
    );

  register("openSettingsSync.configure", "Configure", async (signal) =>
    configure(context, store, signal),
  );
  register("openSettingsSync.sync", "Sync", async (commandSignal) => {
    const result = await withProgress(commandSignal, (signal, progress) =>
      store.exclusive(async (assertOwnership) => {
        const source = await activeSource(context, store, "use");
        const config = await readConfiguration(source);
        const builtin = await builtinInventory(vscode.env.appRoot);
        const host = new EditorHost(source, new Set(builtin.extensions), signal);
        const identity = JSON.stringify({
          remote: config.remote,
          branch: config.branch,
          profile: config.profile,
          uri: source.uri,
          editorProfile: source.editorProfile,
        });
        return await synchronize({
          identity,
          settingsUri: source.uri,
          editor: host,
          persistence: store,
          interaction: {
            resolve: (conflicts) => review.resolve(conflicts, signal),
            review: (plan) => {
              progress.report({
                message: "Waiting for your review. In Preview, choose Apply Sync when ready.",
              });
              return review.review(plan, source.editorProfile || "Default", signal);
            },
          },
          policy: {
            builtinExtensions: builtin.extensions,
            machineSettings: [
              ...builtin.machineSettings,
              ...machineSettings(
                vscode.extensions.all.map((extension) => extension.packageJSON as unknown),
              ),
              ...(await machineSettingsFromDirectory(source.extensionsDirectory, (message) =>
                output.warn(message),
              )),
            ],
            ignoredSettings: config.ignoredSettings,
            ignoredExtensions: config.ignoredExtensions,
            ownExtension: context.extension.id,
          },
          repository: new GitRepository({
            ...config,
            directory: join(
              store.directory,
              "repositories",
              digest(`${config.remote}\n${config.branch}`),
            ),
            git: await gitPath(),
            signal,
          }),
          check() {
            signal.throwIfAborted();
            assertOwnership();
          },
          report(message) {
            progress.report({ message });
          },
        });
      }),
    );
    output.info(
      `Sync ${result.status}; settings=${result.settings}; extensions=${result.extensions}; failedExtensions=${result.failedExtensions.length}.`,
    );
    for (const failure of result.failedExtensions) {
      output.warn(
        `Extension install skipped (${failure.id}): ${formatFailureForLog(failure.error)}`,
      );
    }
    if (result.status === "synced") {
      const extLabel =
        result.extensions === 1
          ? "1 extension installed"
          : `${result.extensions} extensions installed`;
      if (result.failedExtensions.length > 0) {
        const failedIds = result.failedExtensions.map((item) => item.id);
        const summary =
          failedIds.length <= 3
            ? failedIds.join(", ")
            : `${failedIds.slice(0, 3).join(", ")} and ${failedIds.length - 3} more`;
        void vscode.window.showWarningMessage(
          `Settings synchronized; ${extLabel}, ${failedIds.length} failed (${summary}). Add unavailable extensions to openSettingsSync.ignoredExtensions to skip them.`,
        );
      } else {
        void vscode.window.showInformationMessage(`Settings synchronized; ${extLabel}.`);
      }
    } else if (result.status === "unchanged") {
      void vscode.window.showInformationMessage(
        "Settings and extensions are already synchronized.",
      );
    }
  });
  register("openSettingsSync.restore", "Restore", async (commandSignal) => {
    const source = await activeSource(context, store, "use");
    const backups = await store.backups(source.uri);
    const selected = await vscode.window.showQuickPick(
      backups.map((item) => ({ label: item.created, name: item.name })),
      {
        title: "Restore settings backup",
        placeHolder: backups.length
          ? "Choose a backup of this settings file."
          : "No settings backups yet.",
      },
    );
    if (!selected) return;
    const choice = await vscode.window.showWarningMessage(
      "Replace your current settings with this backup?",
      { modal: true },
      "Restore",
    );
    if (choice !== "Restore") return;
    await withProgress(commandSignal, (signal, progress) =>
      store.exclusive(async (assertOwnership) => {
        assertOwnership();
        progress.report({ message: "Restoring settings backup..." });
        const backup = await store.readBackup(source.uri, selected.name);
        const host = new EditorHost(source, new Set(), signal);
        const current = await host.settingsText();
        await store.backup(source.uri, current);
        await host.replace(current, backup.text);
      }),
    );
    void vscode.window.showInformationMessage(
      "Settings restored. Extension installations and Git history were not changed.",
    );
  });
}

function formatFailureForLog(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth++) {
    if (current instanceof SyncFailure) {
      parts.push(`[${current.code}] ${current.message}`);
      current = current.cause;
    } else if (current instanceof Error) {
      parts.push(depth === 0 ? current.message : `Cause: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(depth === 0 ? String(current) : `Cause: ${String(current)}`);
      break;
    }
  }
  return parts.join(" | ") || "Unknown sync failure.";
}

async function gitPath(): Promise<string> {
  const extension = vscode.extensions.getExtension("vscode.git");
  if (extension) {
    try {
      const exports: unknown = await extension.activate();
      if (isRecord(exports) && typeof exports.getAPI === "function") {
        const api: unknown = exports.getAPI(1);
        if (isRecord(api) && isRecord(api.git) && typeof api.git.path === "string") {
          const path = api.git.path.trim();
          if (path) return path;
        }
      }
    } catch {
      // Fall back to system Git when the built-in Git extension is disabled or unavailable.
    }
  }
  return "git";
}
