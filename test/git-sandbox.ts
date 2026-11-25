import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runProcess } from "../src/platform/process";
import { GitRepository } from "../src/git/repository";

/** Local remotes exercise real Git without network access or a user's repository. */
export async function gitSandbox(t: TestContext): Promise<{
  root: string;
  remote: string;
  client(name: string, profile?: string): GitRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  await git(["init", "--bare", "--template=", remote]);
  return {
    root,
    remote,
    client(name, profile = "main") {
      return new GitRepository({
        directory: join(root, name),
        remote,
        branch: "main",
        profile,
        git: "git",
      });
    },
  };
}

/** Test Git author data is scoped to subprocesses, never the developer's configuration. */
export async function git(args: readonly string[], input?: string): Promise<string> {
  const result = await runProcess(
    "git",
    ["-c", "user.name=Sync Test", "-c", "user.email=sync-test@localhost", ...args],
    { input, env: { GIT_TERMINAL_PROMPT: "0" } },
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
