/** Three-way settings merge and additive extension wishes. */
import { orderedObject } from "./json";
import { type Json, type Settings, type Snapshot, setting } from "./snapshot";

/** A null key identifies the top-level order. Undefined values represent deletion. */
export type SettingConflict =
  | {
      readonly key: string;
      readonly base: Json | undefined;
      readonly local: Json | undefined;
      readonly remote: Json | undefined;
    }
  | {
      readonly key: null;
      readonly base: readonly string[];
      readonly local: readonly string[];
      readonly remote: readonly string[];
    };

export type Resolutions = ReadonlyMap<string | null, "local" | "remote">;

/** Updates one complete setting value, preserving unrelated settings. */
export interface SettingChange {
  readonly key: string;
  readonly before: Json | undefined;
  readonly after: Json | undefined;
}

/** Any unresolved conflict prevents application. */
export interface MergeResult {
  readonly snapshot: Snapshot;
  readonly conflicts: readonly SettingConflict[];
}

/** Merges independent edits and propagates deletions relative to the last successful sync. */
export function mergeSnapshots(
  base: Snapshot,
  local: Snapshot,
  remote: Snapshot,
  resolutions: Resolutions = new Map(),
): MergeResult {
  const entries: [string, Json][] = [];
  const conflicts: SettingConflict[] = [];
  const oursOrder = Object.keys(local.settings);
  const theirsOrder = Object.keys(remote.settings);
  const oursShared = oursOrder.filter((key) => Object.hasOwn(remote.settings, key));
  const theirsShared = theirsOrder.filter((key) => Object.hasOwn(local.settings, key));
  let preferLocal = false;
  if (!sameOrder(oursShared, theirsShared)) {
    const baseShared = Object.keys(base.settings).filter(
      (key) => Object.hasOwn(local.settings, key) && Object.hasOwn(remote.settings, key),
    );
    if (sameOrder(theirsShared, baseShared)) preferLocal = true;
    else if (!sameOrder(oursShared, baseShared)) {
      const choice = resolutions.get(null);
      if (choice === undefined)
        conflicts.push({ key: null, base: baseShared, local: oursShared, remote: theirsShared });
      preferLocal = choice === "local";
    }
  }
  const keys = preferLocal ? weaveKeys(oursOrder, theirsOrder) : weaveKeys(theirsOrder, oursOrder);
  for (const key of keys) {
    const original = setting(base.settings, key);
    const ours = setting(local.settings, key);
    const theirs = setting(remote.settings, key);
    let selected: Json | undefined;
    if (sameValue(ours, theirs) || sameValue(theirs, original)) selected = ours;
    else if (sameValue(ours, original)) selected = theirs;
    else {
      const choice = resolutions.get(key);
      if (choice === undefined) {
        conflicts.push({ key, base: original, local: ours, remote: theirs });
        continue;
      }
      selected = choice === "local" ? ours : theirs;
    }
    if (selected !== undefined) entries.push([key, selected]);
  }
  return {
    snapshot: {
      version: 1,
      settings: orderedObject(entries),
      extensions: [...new Set([...local.extensions, ...remote.extensions])].sort(),
    },
    conflicts,
  };
}

/** Includes deletions and changes in the priority of ordered settings. */
export function settingChanges(before: Settings, after: Settings): SettingChange[] {
  const changes: SettingChange[] = [];
  for (const key of new Set([...Object.keys(after), ...Object.keys(before)])) {
    const oldValue = setting(before, key);
    const newValue = setting(after, key);
    if (!sameValue(oldValue, newValue)) changes.push({ key, before: oldValue, after: newValue });
  }
  return changes;
}

/** Returns the target order when deleting and appending the value changes alone cannot produce it. */
export function settingOrderChange(before: Settings, after: Settings): string[] | undefined {
  const target = Object.keys(after);
  const ordinary = [
    ...Object.keys(before).filter((key) => Object.hasOwn(after, key)),
    ...target.filter((key) => !Object.hasOwn(before, key)),
  ];
  return sameOrder(ordinary, target) ? undefined : target;
}

function sameValue(left: Json | undefined, right: Json | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Places keys from the other side before their next shared key, or at the end. */
function weaveKeys(primary: string[], other: string[]): string[] {
  const existing = new Set(primary);
  const before = new Map<string, string[]>();
  let pending: string[] = [];
  for (const key of other) {
    if (!existing.has(key)) pending.push(key);
    else if (pending.length) {
      before.set(key, pending);
      pending = [];
    }
  }
  return primary.flatMap((key) => [...(before.get(key) ?? []), key]).concat(pending);
}
