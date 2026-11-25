/** A private bare Git cache. Trees are edited without checking out repository files. */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ProcessResult, runProcess } from "../platform/process";
import { SyncFailure } from "../sync/failure";
import { parseJsonText } from "../sync/json";
import { isValidBranchName, isValidProfileName } from "../sync/policy";
import type { RemoteState } from "../sync/session";
import { decodeSnapshot, formatJson, type Snapshot } from "../sync/snapshot";

export interface RepositoryOptions {
  readonly directory: string;
  readonly remote: string;
  readonly branch: string;
  readonly profile: string;
  readonly git: string;
  readonly signal?: AbortSignal;
}

/** Only the selected collection is updated; other files and profiles retain their trees. */
export class GitRepository {
  private readonly file: string;
  private initialized = false;
  private sshEnv: NodeJS.ProcessEnv | undefined;
  private identityArgs: readonly string[] = [];

  constructor(private readonly options: RepositoryOptions) {
    validateRemote(options.remote);
    if (!isValidProfileName(options.profile)) {
      throw new SyncFailure("invalid-configuration", "Invalid shared profile name.");
    }
    if (!isValidBranchName(options.branch)) {
      throw new SyncFailure("invalid-configuration", "Invalid Git branch name.");
    }
    this.file = `.settings-sync/${options.profile}.json`;
  }

  /** Queries the current remote branch head without fetching objects. */
  async readHead(): Promise<string | null> {
    await this.initialize();
    const ref = `refs/heads/${this.options.branch}`;
    const advertised = await this.git(
      ["ls-remote", "--heads", "--exit-code", this.options.remote, ref],
      undefined,
      true,
    );
    if (advertised.code === 2) return null;
    this.check(advertised);
    const oid = /^([a-f0-9]{40,64})\t/.exec(advertised.stdout)?.[1];
    if (!oid)
      throw new SyncFailure("invalid-data", "Git returned an unexpected remote ref advertisement.");
    return oid;
  }

  /** Supports existing branches, an absent collection, and a completely empty remote. */
  async read(): Promise<RemoteState> {
    const remoteHead = await this.readHead();
    if (remoteHead === null) return { head: null, snapshot: null };
    const ref = `refs/heads/${this.options.branch}`;
    await this.git([
      "fetch",
      "--no-tags",
      "--depth=1",
      this.options.remote,
      `+${ref}:refs/sync/source`,
    ]);
    const head = (await this.git(["rev-parse", "refs/sync/source"])).stdout.trim();
    const entry = (await this.git(["ls-tree", "-z", head, "--", this.file])).stdout;
    if (entry === "") return { head, snapshot: null };
    const match = /^100(?:644|755) blob ([a-f0-9]{40,64})\t/.exec(entry);
    const oid = match?.[1];
    if (!oid)
      throw new SyncFailure("invalid-data", "The remote snapshot must be a regular JSON file.");
    const bytes = Number((await this.git(["cat-file", "-s", oid])).stdout.trim());
    if (!Number.isSafeInteger(bytes) || bytes > 2 * 1024 * 1024) {
      throw new SyncFailure("invalid-data", "The remote snapshot exceeds 2 MiB.");
    }
    const text = (await this.git(["cat-file", "blob", oid])).stdout;
    let data: unknown;
    try {
      data = parseJsonText(text);
    } catch (cause) {
      throw new SyncFailure("invalid-data", "The remote snapshot is not valid JSON.", { cause });
    }
    return { head, snapshot: decodeSnapshot(data) };
  }

  /** Publishes a child of the reviewed head only while the remote ref still matches it. */
  async publish(previous: RemoteState, snapshot: Snapshot): Promise<void> {
    const contents = formatJson(snapshot);
    if (Buffer.byteLength(contents, "utf8") > 2 * 1024 * 1024) {
      throw new SyncFailure("invalid-data", "The sync snapshot exceeds 2 MiB.");
    }
    const latestHead = await this.readHead();
    if (latestHead !== previous.head) {
      throw new SyncFailure(
        "remote-changed",
        "The Git branch changed during review. Run Sync Now again.",
      );
    }
    const index = join(this.options.directory, `index-${randomUUID()}`);
    const indexEnv = { GIT_INDEX_FILE: index };
    try {
      const blob = (await this.git(["hash-object", "-w", "--stdin"], contents)).stdout.trim();
      await this.git(["read-tree", previous.head ?? "--empty"], undefined, false, indexEnv);
      await this.git(
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${this.file}`],
        undefined,
        false,
        indexEnv,
      );
      const tree = (await this.git(["write-tree"], undefined, false, indexEnv)).stdout.trim();
      const parents = previous.head ? ["-p", previous.head] : [];
      const commit = (
        await this.git(
          ["commit-tree", tree, ...parents],
          `chore(sync): update ${this.options.profile}\n`,
        )
      ).stdout.trim();
      const ref = `refs/heads/${this.options.branch}`;
      const result = await this.git(
        [
          "push",
          "--porcelain",
          `--force-with-lease=${ref}:${previous.head ?? ""}`,
          this.options.remote,
          `${commit}:${ref}`,
        ],
        undefined,
        true,
      );
      if (result.code !== 0) {
        if (isRemoteUpdateRejection(result)) {
          throw gitFailure(
            "remote-changed",
            "Git rejected the push because the remote branch changed. Run Sync Now again.",
            result.stderr,
          );
        }
        throw gitFailure("process-failed", `Git push failed (exit ${result.code}).`, result.stderr);
      }
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.options.directory, { recursive: true });
    // Reinitializing a bare cache is safe and also completes an interrupted initial setup.
    const initialized = await runProcess(
      this.options.git,
      [
        "-c",
        `core.hooksPath=${join(this.options.directory, "no-hooks")}`,
        "init",
        "--bare",
        "--template=",
        this.options.directory,
      ],
      {
        signal: this.options.signal,
        env: {
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_OBJECT_DIRECTORY: undefined,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
          GIT_CONFIG_COUNT: undefined,
        },
      },
    );
    this.check(initialized);
    await this.git(["check-ref-format", "--branch", this.options.branch]);
    if (this.sshEnv === undefined) {
      this.sshEnv = await this.resolveSshEnv();
    }
    this.identityArgs = await this.resolveIdentityArgs();
    this.initialized = true;
  }

  private async resolveSshEnv(): Promise<NodeJS.ProcessEnv> {
    if (process.env.GIT_SSH_COMMAND?.trim() || process.env.GIT_SSH?.trim()) return {};
    const configured = await this.git(["config", "--get", "core.sshCommand"], undefined, true);
    if (configured.code === 0 && configured.stdout.trim()) return {};
    return { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  }

  private async resolveIdentityArgs(): Promise<readonly string[]> {
    const args: string[] = [];
    const name = await this.git(["config", "--get", "user.name"], undefined, true);
    if (name.code !== 0 || !name.stdout.trim()) args.push("-c", "user.name=Open Settings Sync");
    const email = await this.git(["config", "--get", "user.email"], undefined, true);
    if (email.code !== 0 || !email.stdout.trim()) {
      args.push("-c", "user.email=open-settings-sync@localhost");
    }
    return args;
  }

  private async git(
    args: readonly string[],
    input?: string,
    allowFailure = false,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<ProcessResult> {
    const result = await runProcess(
      this.options.git,
      [
        `--git-dir=${this.options.directory}`,
        "-c",
        `core.hooksPath=${join(this.options.directory, "no-hooks")}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "protocol.ext.allow=never",
        ...this.identityArgs,
        ...args,
      ],
      {
        input,
        signal: this.options.signal,
        env: {
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_OBJECT_DIRECTORY: undefined,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
          GIT_CONFIG_COUNT: undefined,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          SSH_ASKPASS_REQUIRE: "never",
          ...this.sshEnv,
          ...extraEnv,
        },
      },
    );
    if (!allowFailure) this.check(result);
    return result;
  }

  private check(result: ProcessResult): void {
    if (result.code !== 0) {
      throw gitFailure("process-failed", `Git failed (exit ${result.code}).`, result.stderr);
    }
  }
}

function gitFailure(
  code: "remote-changed" | "process-failed",
  summary: string,
  stderr: string,
): SyncFailure {
  const details = stderr.trim();
  if (!details) return new SyncFailure(code, summary);
  const firstLine = details.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return new SyncFailure(
    code,
    firstLine ? `${summary} ${firstLine}` : summary,
    details !== firstLine ? { cause: new Error(details) } : undefined,
  );
}

function isRemoteUpdateRejection(result: ProcessResult): boolean {
  if (/^!\t/m.test(result.stdout)) return true;
  return /\b(stale info|non-fast-forward|fetch first)\b/i.test(result.stderr);
}

/** Allows normal Git transports and explicit local paths, but no command transport or URL credentials. */
export function validateRemote(remote: string): void {
  if (!remote || /[\r\n\0]/.test(remote) || remote.startsWith("-")) {
    throw new SyncFailure("invalid-configuration", "Configure a Git remote first.");
  }
  if (
    isAbsolute(remote) ||
    /^[\w.-]+@[\w.-]+:[\w./~%+-]+$/.test(remote) ||
    /^[a-zA-Z0-9][a-zA-Z0-9._-]+:(?!\/{2}|:)[\w.~%+-]+\/[\w./~%+-]+$/.test(remote)
  )
    return;
  try {
    const url = new URL(remote);
    if (
      !["https:", "ssh:", "file:"].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol === "https:" && url.username)
    )
      throw new Error("unsupported");
  } catch (cause) {
    throw new SyncFailure(
      "invalid-configuration",
      "Use an HTTPS or SSH Git URL without embedded credentials, or an absolute local repository path.",
      { cause },
    );
  }
}
