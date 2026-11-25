/** Portable versioned data, independent of editor and IO implementations. */
import { SyncFailure } from "./failure";
import { type Json, orderedObject } from "./json";

export type { Json } from "./json";
export type Settings = Readonly<Record<string, Json>>;

/** Extensions express installation wishes; versions and enablement stay local. */
export interface Snapshot {
  readonly version: 1;
  readonly settings: Settings;
  readonly extensions: readonly string[];
}

const extensionIdPattern = /^[a-zA-Z0-9][\w-]*\.[a-zA-Z0-9][\w-]*$/;

/** Validates Marketplace/Open VSX extension identifiers while rejecting flag-like leading hyphens. */
export function isValidExtensionId(id: string): boolean {
  return extensionIdPattern.test(id);
}

/** Rejects unsupported schemas and validates data read from Git or persistence. */
export function decodeSnapshot(input: unknown): Snapshot {
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    Object.keys(input).some((key) => !["version", "settings", "extensions"].includes(key)) ||
    !isRecord(input.settings) ||
    !Array.isArray(input.extensions)
  ) {
    throw new SyncFailure(
      "invalid-data",
      "Unsupported sync snapshot. Expected version 1 settings and extensions.",
    );
  }
  const extensions: string[] = [];
  for (const id of input.extensions) {
    if (typeof id !== "string" || !isValidExtensionId(id)) {
      throw new SyncFailure("invalid-data", "Invalid extension identifier in sync snapshot.");
    }
    extensions.push(id.toLowerCase());
  }
  return {
    version: 1,
    settings: decodeSettings(input.settings),
    extensions: [...new Set(extensions)].sort(),
  };
}

/** Validates JSON settings and bounds recursive processing. */
export function decodeSettings(input: unknown): Settings {
  if (!isRecord(input)) throw new SyncFailure("invalid-data", "Settings must be a JSON object.");
  return copyJson(input, 0) as Settings;
}

/** Formats a snapshot or setting without changing its key or array order. */
export function formatJson(value: Json | Snapshot): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Absence is distinct from an explicit JSON null. */
export function setting(settings: Settings, key: string): Json | undefined {
  return Object.hasOwn(settings, key) ? settings[key] : undefined;
}

/** Initial baseline for a client or remote with no previous sync. */
export function emptySnapshot(): Snapshot {
  return { version: 1, settings: {}, extensions: [] };
}

/** Narrows external representations before accessing their fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyJson(value: unknown, depth: number): Json {
  if (depth > 50) throw new SyncFailure("invalid-data", "Settings nesting exceeds 50 levels.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((child) => copyJson(child, depth + 1));
  if (isRecord(value))
    return orderedObject(
      Object.entries(value).map(([key, child]) => [key, copyJson(child, depth + 1)]),
    );
  throw new SyncFailure("invalid-data", "Setting values must be JSON.");
}
