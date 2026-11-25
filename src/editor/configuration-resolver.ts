/** Pure profile configuration resolution; keeps inheritance and validation testable outside VS Code. */
import { SyncFailure } from "../sync/failure";
import { type Settings, setting } from "../sync/snapshot";

export interface ConnectionSettings {
  readonly remote: string;
  readonly branch: string;
  readonly profile: string;
}

/** Legacy named profiles inherit connection fields only until they define their own remote. */
export function resolveConnection(local: Settings, defaults: Settings): ConnectionSettings {
  const inherited = Object.hasOwn(local, "openSettingsSync.git.remote") ? {} : defaults;
  const field = (key: string, fallback: string): string => {
    const values = Object.hasOwn(local, key) ? local : inherited;
    const value = setting(values, key);
    if (value === undefined) return fallback;
    if (typeof value !== "string")
      throw new SyncFailure("invalid-configuration", `${key} must be a string.`);
    return value;
  };
  return {
    remote: field("openSettingsSync.git.remote", ""),
    branch: field("openSettingsSync.git.branch", "main"),
    profile: field("openSettingsSync.profile", "main"),
  };
}

/** Combines default and profile ignore lists; rejects non-string lists before any sync side effect. */
export function resolveIgnoredPatterns(
  key: string,
  defaults: Settings,
  local: Settings,
): readonly string[] {
  const patterns = [defaults, local].flatMap((settings) => {
    const value = setting(settings, key);
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
      throw new SyncFailure("invalid-configuration", `${key} must be a list of strings.`);
    return value;
  });
  return [...new Set(patterns)];
}
