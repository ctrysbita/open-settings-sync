/** Portable selection that preserves each machine's excluded configuration. */
import { orderedObject } from "./json";
import type { Json, Snapshot } from "./snapshot";

/** Host-discovered facts and user exclusions; unknown built-ins are never guessed as user extensions. */
export interface PolicyOptions {
  readonly builtinExtensions: readonly string[];
  readonly machineSettings: readonly string[];
  readonly ignoredSettings: readonly string[];
  readonly ignoredExtensions: readonly string[];
  readonly ownExtension: string;
}

/** Selection is shared by all three sides for the duration of one sync. */
export interface SyncPolicy {
  readonly excludedSettings: readonly string[];
  readonly excludedExtensions: readonly string[];
  select(snapshot: Snapshot): Snapshot;
  retainRemote(remote: Snapshot, merged: Snapshot): Snapshot;
}

/** Single source of truth for shared collection names (mirrors package.json schema). */
export const profileNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Single source of truth for Git branch names accepted by configuration and repository adapters. */
export const branchNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/;

/** Validates a shared collection profile name. */
export function isValidProfileName(name: string): boolean {
  return profileNamePattern.test(name);
}

/** Validates a Git branch name before invoking Git ref checks. */
export function isValidBranchName(name: string): boolean {
  return branchNamePattern.test(name);
}

/** Matches editor-owned internal extension namespaces that must never be installed or removed. */
export function isInternalExtensionId(id: string): boolean {
  const normalized = id.toLowerCase();
  return (
    normalized.startsWith("vscode.") ||
    normalized.startsWith("anysphere.cursor-") ||
    normalized.startsWith("cursor.cursor-")
  );
}

const localSettings = [
  "openSettingsSync.*",
  "settingsSync.*",
  "syncSettings.*",
  "cursorAuth.*",
  "terminal.integrated.env.*",
  "terminal.integrated.profiles.*",
  "terminal.integrated.defaultProfile.*",
  "terminal.integrated.automationProfile.*",
  "python.defaultInterpreterPath",
  "python.venvPath",
  "git.path",
  "http.proxy",
];

/** A machine-only or ignored key on any side excludes its whole setting from the merge. */
export function createPolicy(options: PolicyOptions, sides: readonly Snapshot[]): SyncPolicy {
  const settingPatterns = normalizePatterns([...localSettings, ...options.ignoredSettings]);
  const extensionPatterns = normalizePatterns(options.ignoredExtensions);
  const machine = new Set(options.machineSettings);
  const builtin = new Set(options.builtinExtensions.map((id) => id.toLowerCase()));
  const own = options.ownExtension.toLowerCase();
  const excludedSettings = new Set<string>();
  const excludedExtensions = new Set<string>();
  const protectedExtension = (id: string): boolean => builtin.has(id) || isInternalExtensionId(id);
  const excludedExtension = (id: string): boolean =>
    protectedExtension(id) || id === own || matches(id, extensionPatterns);
  for (const side of sides) {
    for (const [key, value] of Object.entries(side.settings)) {
      if (
        machine.has(key) ||
        matches(key, settingPatterns) ||
        containsExcludedKey(key, value, settingPatterns, machine)
      )
        excludedSettings.add(key);
    }
    for (const id of side.extensions) {
      if (excludedExtension(id)) excludedExtensions.add(id);
    }
  }
  return {
    excludedSettings: [...excludedSettings].sort(),
    excludedExtensions: [...excludedExtensions].sort(),
    select(snapshot) {
      return {
        version: 1,
        settings: orderedObject(
          Object.entries(snapshot.settings).filter(([key]) => !excludedSettings.has(key)),
        ),
        extensions: snapshot.extensions.filter((id) => !excludedExtension(id)).sort(),
      };
    },
    retainRemote(remote, merged) {
      const remaining = Object.entries(merged.settings).values();
      const entries: [string, Json][] = [];
      for (const [key, value] of Object.entries(remote.settings)) {
        if (excludedSettings.has(key)) entries.push([key, value]);
        else if (Object.hasOwn(merged.settings, key)) {
          const next = remaining.next();
          if (!next.done) entries.push(next.value);
        }
      }
      return {
        version: 1,
        settings: orderedObject([...entries, ...remaining]),
        extensions: [...new Set([...remote.extensions, ...merged.extensions])].sort(),
      };
    },
  };
}

function normalizePatterns(patterns: readonly string[]): readonly string[] {
  return patterns.map((pattern) => pattern.toLowerCase().replace(/\*+/g, "*"));
}

/** Case-insensitive linear-time '*' wildcard matcher (immune to regex backtracking). */
export function matchWildcard(text: string, pattern: string): boolean {
  const value = text.toLowerCase();
  const glob = pattern.toLowerCase();
  let ti = 0;
  let pi = 0;
  let starIndex = -1;
  let matchIndex = 0;
  while (ti < value.length) {
    if (pi < glob.length && glob[pi] === "*") {
      starIndex = pi++;
      matchIndex = ti;
    } else if (pi < glob.length && glob[pi] === value[ti]) {
      pi++;
      ti++;
    } else if (starIndex !== -1) {
      pi = starIndex + 1;
      ti = ++matchIndex;
    } else {
      return false;
    }
  }
  while (pi < glob.length && glob[pi] === "*") pi++;
  return pi === glob.length;
}

function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchWildcard(name, pattern));
}

function containsExcludedKey(
  path: string,
  value: Json,
  patterns: readonly string[],
  machine: ReadonlySet<string>,
): boolean {
  if (Array.isArray(value))
    return value.some((child) => containsExcludedKey(path, child, patterns, machine));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      machine.has(key) ||
      matches(`${path}.${key}`, patterns) ||
      matches(key, patterns) ||
      containsExcludedKey(`${path}.${key}`, child, patterns, machine),
  );
}
