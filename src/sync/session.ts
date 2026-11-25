/** Sync orchestration over explicit capabilities; no editor, filesystem, or Git dependencies. */
import { SyncFailure } from "./failure";
import {
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

/** Raw text detects edits made while a preview or installation is in progress. */
export interface LocalState {
  readonly snapshot: Snapshot;
  readonly settingsText: string;
}

/** All side effects shown to the user before admission. */
export interface SyncPlan {
  readonly settings: readonly SettingChange[];
  readonly settingsOrder?: readonly string[] | undefined;
  readonly installExtensions: readonly string[];
  readonly upload: boolean;
  readonly recreateCollection: boolean;
  readonly gitSettings: readonly SettingChange[];
  readonly gitSettingsOrder?: readonly string[] | undefined;
  readonly gitExtensions: readonly string[];
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

/** An extension installation that failed without blocking settings or remaining extensions. */
export interface ExtensionInstallFailure {
  readonly id: string;
  readonly error: unknown;
}

/** Extension installations cannot be rolled back atomically with settings or a Git push. */
export interface SyncResult {
  readonly status: "cancelled" | "unchanged" | "synced";
  readonly settings: number;
  readonly extensions: number;
  readonly failedExtensions: readonly ExtensionInstallFailure[];
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
  const gitExtensions = target.extensions.filter((id) => !remoteSnapshot.extensions.includes(id));
  const plan: SyncPlan = {
    settings: settingChanges(local.settings, merged.snapshot.settings),
    settingsOrder: settingOrderChange(local.settings, merged.snapshot.settings),
    installExtensions: merged.snapshot.extensions.filter(
      (id) => !initial.snapshot.extensions.includes(id),
    ),
    upload:
      recreateCollection ||
      gitSettings.length > 0 ||
      gitSettingsOrder !== undefined ||
      gitExtensions.length > 0,
    recreateCollection,
    gitSettings,
    gitSettingsOrder,
    gitExtensions,
    excludedSettings: policy.excludedSettings,
    excludedExtensions: policy.excludedExtensions,
  };
  const writesSettings = plan.settings.length > 0 || plan.settingsOrder !== undefined;
  const changed = plan.upload || writesSettings || plan.installExtensions.length > 0;
  const failedExtensions: ExtensionInstallFailure[] = [];
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
    for (const [index, id] of plan.installExtensions.entries()) {
      env.check();
      env.report?.(`Installing extension (${index + 1}/${plan.installExtensions.length}): ${id}`);
      try {
        await env.editor.installExtension(id);
      } catch (error) {
        if (isFatalInstallError(error)) throw error;
        env.check();
        failedExtensions.push({ id, error });
      }
    }
    env.check();
    const failedIds = new Set(failedExtensions.map((item) => item.id));
    if (plan.installExtensions.length > 0) {
      env.report?.("Verifying synchronized state...");
      const verified = policy.select((await env.editor.read()).snapshot);
      const missingExtensions = merged.snapshot.extensions.filter(
        (id) => !failedIds.has(id) && !verified.extensions.includes(id),
      );
      const settingsMismatch = describeSettingsMismatch(
        merged.snapshot.settings,
        verified.settings,
      );
      if (settingsMismatch || missingExtensions.length > 0) {
        const details = [
          settingsMismatch,
          missingExtensions.length > 0
            ? `Missing extensions: ${missingExtensions.join(", ")}`
            : undefined,
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
  const failedIds = new Set(failedExtensions.map((item) => item.id));
  const baselineSnapshot: Snapshot =
    failedIds.size > 0
      ? {
          version: 1,
          settings: merged.snapshot.settings,
          extensions: merged.snapshot.extensions.filter((id) => !failedIds.has(id)),
        }
      : merged.snapshot;
  if (remote.snapshot !== null || plan.upload)
    await env.persistence.saveBaseline(env.identity, baselineSnapshot);
  return {
    status: changed ? "synced" : "unchanged",
    settings: plan.settings.length,
    extensions: plan.installExtensions.length - failedExtensions.length,
    failedExtensions,
  };
}

function describeSettingsMismatch(expected: Settings, actual: Settings): string | undefined {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return undefined;
  const keys = settingChanges(expected, actual).map((change) => change.key);
  return keys.length > 0 ? `Settings differ: ${keys.join(", ")}` : "Setting key order differs";
}

function isFatalInstallError(error: unknown): boolean {
  if (error instanceof SyncFailure) return error.code !== "process-failed";
  return error instanceof Error && error.name === "AbortError";
}

function cancelled(): SyncResult {
  return { status: "cancelled", settings: 0, extensions: 0, failedExtensions: [] };
}
