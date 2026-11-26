/** Sync orchestration over explicit capabilities; no editor, filesystem, or Git dependencies. */
import { SyncFailure } from "./failure";
import {
  extensionChanges,
  mergeSnapshots,
  type Resolutions,
  type SettingChange,
  type SettingConflict,
  settingChanges,
  settingOrderChange,
} from "./merge";
import { createPolicy, type PolicyOptions } from "./policy";
import { emptySnapshot, type Settings, type Snapshot } from "./snapshot";

/** A null snapshot means the collection is absent. A null head also means the branch is absent. */
export interface RemoteState {
  readonly head: string | null;
  readonly snapshot: Snapshot | null;
}

/** Raw text detects edits made while a sync is in progress. */
export interface LocalState {
  readonly snapshot: Snapshot;
  readonly settingsText: string;
}

/** All side effects shown to the user before admission. */
export interface SyncPlan {
  readonly settings: readonly SettingChange[];
  readonly settingsOrder?: readonly string[] | undefined;
  readonly installExtensions: readonly string[];
  readonly uninstallExtensions: readonly string[];
  readonly upload: boolean;
  readonly recreateCollection: boolean;
  readonly gitSettings: readonly SettingChange[];
  readonly gitSettingsOrder?: readonly string[] | undefined;
  /** IDs to add to the Git snapshot. */
  readonly gitExtensions: readonly string[];
  readonly gitRemovedExtensions: readonly string[];
  readonly excludedSettings: readonly string[];
  readonly excludedExtensions: readonly string[];
}

/** Adapters must throw on failure and must not silently skip an admitted write. */
export interface SyncEnvironment {
  readonly identity: string;
  readonly settingsUri: string;
  readonly policy: PolicyOptions;
  readonly editor: {
    read(): Promise<LocalState>;
    readSettings?(): Promise<Settings>;
    applySettings(
      expectedText: string,
      changes: readonly SettingChange[],
      order?: readonly string[],
    ): Promise<void>;
    installExtension(id: string): Promise<void>;
    /** May remove only IDs approved for uninstallation, including extension pack members. */
    uninstallExtension(id: string, approved: ReadonlySet<string>): Promise<void>;
  };
  readonly repository: {
    read(): Promise<RemoteState>;
    readHead?(): Promise<string | null>;
    publish(previous: RemoteState, snapshot: Snapshot): Promise<void>;
  };
  readonly persistence: {
    baseline(identity: string): Promise<Snapshot | undefined>;
    saveBaseline(identity: string, snapshot: Snapshot): Promise<void>;
    backup(uri: string, text: string): Promise<void>;
  };
  readonly interaction: {
    resolve(conflicts: readonly SettingConflict[]): Promise<Resolutions | undefined>;
    review(plan: SyncPlan): Promise<boolean>;
  };
  /** Called before side effects to enforce cancellation and exclusive ownership. */
  check(): void;
  /** Optional progress updates for long-running sync stages. */
  report?(message: string): void;
}

interface ExtensionFailure {
  readonly id: string;
  readonly operation: "install" | "uninstall";
  readonly error: unknown;
}

/** Counts verified local changes. Individual CLI failures can be retried on the next sync. */
export interface SyncResult {
  readonly status: "cancelled" | "unchanged" | "synced";
  readonly settings: number;
  /** Number of extensions installed in this profile. */
  readonly extensions: number;
  readonly uninstalledExtensions: number;
  readonly failedExtensions: readonly ExtensionFailure[];
}

/** Records a baseline only after publication and verified local settings writes succeed. */
export async function synchronize(env: SyncEnvironment): Promise<SyncResult> {
  env.check();
  env.report?.("Reading Git repository...");
  const remote = await env.repository.read();
  env.report?.("Reading local settings and extensions...");
  const initial = await env.editor.read();
  const previous = await env.persistence.baseline(env.identity);
  const baseline = previous ?? emptySnapshot();
  const remoteSnapshot = remote.snapshot ?? emptySnapshot();
  const policy = createPolicy(env.policy, [baseline, initial.snapshot, remoteSnapshot]);
  const local = policy.select(initial.snapshot);
  const base = remote.snapshot === null ? emptySnapshot() : policy.select(baseline);
  const theirs = policy.select(remoteSnapshot);
  let merged = mergeSnapshots(base, local, theirs);
  if (merged.conflicts.length > 0) {
    const resolutions = await env.interaction.resolve(merged.conflicts);
    if (resolutions === undefined) return cancelled();
    merged = mergeSnapshots(base, local, theirs, resolutions);
    if (merged.conflicts.length > 0)
      throw new SyncFailure("invalid-data", "Not every setting conflict was resolved.");
  }
  const target = policy.retainRemote(remoteSnapshot, merged.snapshot);
  const recreateCollection = previous !== undefined && remote.snapshot === null;
  const gitSettings = settingChanges(remoteSnapshot.settings, target.settings);
  const gitSettingsOrder = settingOrderChange(remoteSnapshot.settings, target.settings);
  const localExtensions = extensionChanges(local.extensions, merged.snapshot.extensions);
  const gitExtensions = extensionChanges(remoteSnapshot.extensions, target.extensions);
  const plan: SyncPlan = {
    settings: settingChanges(local.settings, merged.snapshot.settings),
    settingsOrder: settingOrderChange(local.settings, merged.snapshot.settings),
    installExtensions: localExtensions.added,
    uninstallExtensions: localExtensions.removed,
    upload:
      recreateCollection ||
      gitSettings.length > 0 ||
      gitSettingsOrder !== undefined ||
      gitExtensions.added.length > 0 ||
      gitExtensions.removed.length > 0,
    recreateCollection,
    gitSettings,
    gitSettingsOrder,
    gitExtensions: gitExtensions.added,
    gitRemovedExtensions: gitExtensions.removed,
    excludedSettings: policy.excludedSettings,
    excludedExtensions: policy.excludedExtensions,
  };
  const writesSettings = plan.settings.length > 0 || plan.settingsOrder !== undefined;
  const writesExtensions = plan.installExtensions.length > 0 || plan.uninstallExtensions.length > 0;
  const changed = plan.upload || writesSettings || writesExtensions;
  const baselineExtensions = new Set(merged.snapshot.extensions);
  const failedExtensions: ExtensionFailure[] = [];
  if (changed) {
    if (!(await env.interaction.review(plan))) return cancelled();
    env.check();
    env.report?.("Verifying local state...");
    const current = await env.editor.read();
    if (
      current.settingsText !== initial.settingsText ||
      JSON.stringify(current.snapshot.extensions) !== JSON.stringify(initial.snapshot.extensions)
    ) {
      throw new SyncFailure(
        "local-changed",
        "Local settings or extensions changed during review. Run Sync Now again.",
      );
    }
    if (plan.upload) {
      env.report?.("Publishing changes to Git...");
      await env.repository.publish(remote, target);
    } else {
      const currentHead = env.repository.readHead
        ? await env.repository.readHead()
        : (await env.repository.read()).head;
      if (currentHead !== remote.head) {
        throw new SyncFailure(
          "remote-changed",
          "The Git branch changed during review. Run Sync Now again.",
        );
      }
    }
    env.check();
    if (writesSettings) {
      env.report?.("Backing up local settings...");
      await env.persistence.backup(env.settingsUri, initial.settingsText);
      env.check();
      env.report?.("Applying local settings...");
      await env.editor.applySettings(initial.settingsText, plan.settings, plan.settingsOrder);
    }
    if (writesExtensions) {
      const failures = await applyExtensionChanges(env, plan);
      env.check();
      env.report?.("Verifying synchronized state...");
      const verified = policy.select((await env.editor.read()).snapshot);
      const installed = new Set(verified.extensions);
      // Keep the observed membership for failed operations so the next sync retries in the same direction.
      for (const failure of failures) {
        const present = installed.has(failure.id);
        if (present === baselineExtensions.has(failure.id)) continue;
        failedExtensions.push(failure);
        if (present) baselineExtensions.add(failure.id);
        else baselineExtensions.delete(failure.id);
      }
      const missingExtensions = [...baselineExtensions].filter((id) => !installed.has(id));
      const stillInstalled = plan.uninstallExtensions.filter(
        (id) => installed.has(id) && !baselineExtensions.has(id),
      );
      const settingsMismatch = describeSettingsMismatch(
        merged.snapshot.settings,
        verified.settings,
      );
      if (settingsMismatch || missingExtensions.length > 0 || stillInstalled.length > 0) {
        const details = [
          settingsMismatch,
          missingExtensions.length > 0
            ? `Missing extensions: ${missingExtensions.join(", ")}`
            : undefined,
          stillInstalled.length > 0 ? `Still installed: ${stillInstalled.join(", ")}` : undefined,
        ]
          .filter(Boolean)
          .join("; ");
        throw new SyncFailure(
          "verification-failed",
          "Local changes did not match the sync plan. The baseline was not advanced; retry after reviewing the log.",
          { cause: new Error(details) },
        );
      }
    } else if (writesSettings) {
      env.check();
      env.report?.("Verifying synchronized settings...");
      const verifiedSettings = env.editor.readSettings
        ? policy.select({
            version: 1,
            settings: await env.editor.readSettings(),
            extensions: [],
          }).settings
        : policy.select((await env.editor.read()).snapshot).settings;
      const settingsMismatch = describeSettingsMismatch(merged.snapshot.settings, verifiedSettings);
      if (settingsMismatch) {
        throw new SyncFailure(
          "verification-failed",
          "Local changes did not match the sync plan. The baseline was not advanced; retry after reviewing the log.",
          { cause: new Error(settingsMismatch) },
        );
      }
    }
  }
  env.check();
  if (remote.snapshot !== null || plan.upload)
    await env.persistence.saveBaseline(env.identity, {
      ...merged.snapshot,
      extensions: [...baselineExtensions].sort(),
    });
  return {
    status: changed ? "synced" : "unchanged",
    settings: plan.settings.length,
    extensions: plan.installExtensions.filter((id) => baselineExtensions.has(id)).length,
    uninstalledExtensions: plan.uninstallExtensions.filter((id) => !baselineExtensions.has(id))
      .length,
    failedExtensions,
  };
}

async function applyExtensionChanges(
  env: SyncEnvironment,
  plan: SyncPlan,
): Promise<ExtensionFailure[]> {
  const failures: ExtensionFailure[] = [];
  const approved = new Set(plan.uninstallExtensions);
  for (const [operation, ids] of [
    ["install", plan.installExtensions],
    ["uninstall", plan.uninstallExtensions],
  ] as const) {
    const verb = operation === "install" ? "Installing" : "Uninstalling";
    for (const [index, id] of ids.entries()) {
      env.check();
      env.report?.(`${verb} extension (${index + 1}/${ids.length}): ${id}`);
      try {
        if (operation === "install") await env.editor.installExtension(id);
        else await env.editor.uninstallExtension(id, approved);
      } catch (error) {
        if (isFatalExtensionError(error)) throw error;
        env.check();
        failures.push({ id, operation, error });
      }
    }
  }
  return failures;
}

function describeSettingsMismatch(expected: Settings, actual: Settings): string | undefined {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return undefined;
  const keys = settingChanges(expected, actual).map((change) => change.key);
  return keys.length > 0 ? `Settings differ: ${keys.join(", ")}` : "Setting key order differs";
}

function isFatalExtensionError(error: unknown): boolean {
  if (error instanceof SyncFailure) return error.code !== "process-failed";
  return error instanceof Error && error.name === "AbortError";
}

function cancelled(): SyncResult {
  return {
    status: "cancelled",
    settings: 0,
    extensions: 0,
    uninstalledExtensions: 0,
    failedExtensions: [],
  };
}
