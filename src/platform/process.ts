/** Bounded, cancellable child execution with no shell interpolation. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { SyncFailure } from "../sync/failure";

/** Nonzero exits are returned so adapters can interpret documented exit codes. */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Optional environment entries set to undefined are removed from the child. */
export interface ProcessOptions {
  readonly cwd?: string;
  readonly input?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
}

/** Rejects on launch failure, cancellation, timeout, or output above 8 MiB. */
export async function runProcess(
  binary: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new SyncFailure("cancelled", "Sync cancelled.");
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let size = 0;
    let failure: Error | undefined;
    let stopping = false;
    let settled = false;
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: buildChildEnv(process.env, options.env),
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? -1, stdout, stderr });
    };
    const destroyStreams = (): void => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const stop = (error: Error): void => {
      failure ??= error;
      if (stopping) return;
      stopping = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, shell: false, stdio: "ignore" },
        );
        killer.on("error", () => {
          child.kill("SIGKILL");
          destroyStreams();
        });
        killer.on("close", (code) => {
          if (code !== 0) {
            child.kill("SIGKILL");
            destroyStreams();
          }
        });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    const abort = (): void => stop(new SyncFailure("cancelled", "Sync cancelled."));
    const timer = setTimeout(
      () => stop(new SyncFailure("process-failed", "A subprocess exceeded its time limit.")),
      options.timeoutMs ?? 60000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (part: string, channel: "stdout" | "stderr"): void => {
      size += Buffer.byteLength(part);
      if (size > 8 * 1024 * 1024) {
        stop(new SyncFailure("process-failed", "A subprocess exceeded the output limit."));
        return;
      }
      if (channel === "stdout") stdout += part;
      else stderr += part;
    };
    child.stdout.on("data", (part: string) => collect(part, "stdout"));
    child.stderr.on("data", (part: string) => collect(part, "stderr"));
    child.on("error", (error) => {
      failure ??= new SyncFailure("process-failed", "Could not start subprocess.", {
        cause: error,
      });
      settle(null);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "EOF" && error.code !== "ECONNRESET") {
        failure ??= error;
      }
    });
    child.on("close", settle);
    child.stdin.end(options.input);
    if (options.signal?.aborted) abort();
  });
}

/** Builds a clean child environment, removing undefined keys case-insensitively on Windows. */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  overrides?: NodeJS.ProcessEnv,
  caseInsensitive = process.platform === "win32",
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const existingKeys = new Map<string, string>();
  const setEntry = (key: string, value: string | undefined): void => {
    const normalized = caseInsensitive ? key.toLowerCase() : key;
    const previous = existingKeys.get(normalized);
    if (previous !== undefined && previous !== key) {
      delete result[previous];
      existingKeys.delete(normalized);
    }
    if (value === undefined) {
      delete result[key];
      existingKeys.delete(normalized);
    } else {
      result[key] = value;
      existingKeys.set(normalized, key);
    }
  };
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) setEntry(key, value);
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      setEntry(key, value);
    }
  }
  return result;
}
