/** Atomic persistence owned exclusively by this extension. No editor databases are accessed. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { SyncFailure } from "../sync/failure";
import { parseJsonText } from "../sync/json";
import { decodeSnapshot, formatJson, isRecord, type Snapshot } from "../sync/snapshot";

/** Describes the settings document explicitly selected during configuration. */
export interface SettingsSource {
  readonly uri: string;
  readonly userDataDirectory: string;
  readonly editorProfile: string;
  readonly extensionsDirectory: string;
}

/** A restore operation only targets the currently selected source. */
export interface SettingsBackup {
  readonly uri: string;
  readonly text: string;
  readonly created: string;
}

const maxBackupsPerSource = 20;

/** Baselines and backups are ordinary files under globalStorageUri. */
export class FileStore {
  constructor(readonly directory: string) {}

  /** One writer across editor windows, with heartbeat-based recovery after crashes. */
  async exclusive<T>(operation: (assertOwnership: () => void) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    let compromised: Error | undefined;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.directory, {
        lockfilePath: resolve(this.directory, "sync.lock"),
        realpath: false,
        stale: 60000,
        update: 15000,
        retries: 0,
        onCompromised(error) {
          compromised = error;
        },
      });
    } catch (cause) {
      throw new SyncFailure(
        "busy",
        "Another settings sync is running. After a crashed editor, wait one minute and retry.",
        { cause },
      );
    }
    let result: T;
    try {
      result = await operation(() => {
        if (compromised)
          throw new SyncFailure("busy", "The sync lock was lost. Retry the operation.", {
            cause: compromised,
          });
      });
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
    try {
      await release();
    } catch (error) {
      if (!compromised) throw error;
    }
    return result;
  }

  /** Lists only bindings for the active settings URI, including a matching pre-upgrade binding. */
  async sources(uri: string): Promise<readonly SettingsSource[]> {
    const value = await readJson(join(this.directory, "sources", `${digest(uri)}.json`));
    if (value === undefined) {
      const legacy = await readJson(join(this.directory, "source.json"));
      if (legacy === undefined) return [];
      const source = decodeSource(legacy);
      return source.uri === uri ? [source] : [];
    }
    if (!Array.isArray(value))
      throw new SyncFailure("invalid-data", "Invalid local profile bindings.");
    const sources = value.map(decodeSource);
    if (sources.some((source) => source.uri !== uri))
      throw new SyncFailure("invalid-data", "A profile binding belongs to another settings file.");
    return sources;
  }

  /** Upserts under the store's exclusive lock. Profiles may intentionally share a settings URI. */
  async saveSource(source: SettingsSource): Promise<void> {
    const previous = await this.sources(source.uri);
    const sources = [
      ...previous.filter((item) => item.editorProfile !== source.editorProfile),
      source,
    ];
    await atomicWrite(
      join(this.directory, "sources", `${digest(source.uri)}.json`),
      JSON.stringify(sources, null, 2),
    );
  }

  /** An absent baseline distinguishes a new client from one that synchronized an empty collection. */
  async baseline(identity: string): Promise<Snapshot | undefined> {
    const value = await readJson(
      join(this.directory, "baselines", `${digest(identity)}.json`),
      parseJsonText,
    );
    return value === undefined ? undefined : decodeSnapshot(value);
  }

  async saveBaseline(identity: string, snapshot: Snapshot): Promise<void> {
    await atomicWrite(
      join(this.directory, "baselines", `${digest(identity)}.json`),
      formatJson(snapshot),
    );
  }

  /** Backups include ignored values and therefore remain local, with private file permissions. */
  async backup(uri: string, text: string): Promise<void> {
    const created = new Date().toISOString();
    const name = `${created.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
    const directory = this.backupDirectory(uri);
    await atomicWrite(join(directory, name), JSON.stringify({ uri, text, created }));
    const existing = await this.backups(uri);
    for (const stale of existing.slice(maxBackupsPerSource)) {
      await rm(join(directory, stale.name), { force: true });
    }
  }

  async backups(uri: string): Promise<readonly { name: string; created: string }[]> {
    const directory = this.backupDirectory(uri);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw cause;
    }
    const result: { name: string; created: string }[] = [];
    for (const name of names
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .reverse()) {
      let item: SettingsBackup;
      try {
        item = await this.readBackup(uri, name);
      } catch (error) {
        if (error instanceof SyncFailure && error.code === "invalid-data") continue;
        throw error;
      }
      if (item.uri === uri) result.push({ name, created: item.created });
    }
    return result;
  }

  async readBackup(uri: string, name: string): Promise<SettingsBackup> {
    if (!/^[\w.-]+\.json$/.test(name))
      throw new SyncFailure("invalid-data", "Invalid backup name.");
    const item = await readJson(join(this.backupDirectory(uri), name));
    if (
      !isRecord(item) ||
      typeof item.uri !== "string" ||
      typeof item.text !== "string" ||
      typeof item.created !== "string"
    ) {
      throw new SyncFailure("invalid-data", "Invalid settings backup.");
    }
    if (item.uri !== uri) {
      throw new SyncFailure("invalid-data", "This backup belongs to a different settings file.");
    }
    return { uri: item.uri, text: item.text, created: item.created };
  }

  private backupDirectory(uri: string): string {
    return join(this.directory, "backups", digest(uri));
  }
}

function decodeSource(value: unknown): SettingsSource {
  if (
    !isRecord(value) ||
    typeof value.uri !== "string" ||
    typeof value.userDataDirectory !== "string" ||
    typeof value.editorProfile !== "string" ||
    typeof value.extensionsDirectory !== "string"
  ) {
    throw new SyncFailure(
      "invalid-data",
      "Invalid local source configuration. Run Configure again.",
    );
  }
  return {
    uri: value.uri,
    userDataDirectory: value.userDataDirectory,
    editorProfile: value.editorProfile,
    extensionsDirectory: value.extensionsDirectory,
  };
}

/** Stable cache identities keep independent remotes, branches, sources, and profiles separate. */
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(
  file: string,
  parse: (text: string) => unknown = JSON.parse,
): Promise<unknown> {
  try {
    return parse(await readFile(file, "utf8"));
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw new SyncFailure("invalid-data", "Could not read local sync state.", { cause });
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
