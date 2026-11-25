import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChildEnv, runProcess } from "../src/platform/process";

test("arguments reach a subprocess literally without shell expansion", async () => {
  const text = 'spaces & $(not-a-command) ; "quotes"';
  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    text,
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, text);
});

test("nonzero exits retain their status and launch errors preserve their causes", async () => {
  assert.equal((await runProcess(process.execPath, ["-e", "process.exit(7)"])).code, 7);
  await assert.rejects(
    runProcess("vscode-sync-nonexistent-command-12345", []),
    (error: unknown) => error instanceof Error && error.cause instanceof Error,
  );
});

test("a cancelled operation does not launch a child and a stuck child is bounded", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runProcess("vscode-sync-nonexistent-command", [], { signal: controller.signal }),
    { code: "cancelled" },
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 100000)"], { timeoutMs: 25 }),
    { code: "process-failed" },
  );
});

test("undefined environment entries are stripped, including case-insensitively on Windows", async () => {
  const insensitive = buildChildEnv(
    { git_dir: "/wrong", Git_Work_Tree: "/also-wrong", KEEP: "1" },
    { GIT_DIR: undefined, GIT_WORK_TREE: "/override", NEW_VAR: "2" },
    true,
  );
  assert.deepEqual(insensitive, { KEEP: "1", GIT_WORK_TREE: "/override", NEW_VAR: "2" });
  assert.equal(Object.hasOwn(insensitive, "git_dir"), false);
  assert.equal(Object.hasOwn(insensitive, "GIT_DIR"), false);

  const sensitive = buildChildEnv(
    { git_dir: "/keep-lower", GIT_DIR: "/drop-upper" },
    { GIT_DIR: undefined },
    false,
  );
  assert.deepEqual(sensitive, { git_dir: "/keep-lower" });

  const child = await runProcess(
    process.execPath,
    ["-e", 'process.stdout.write(String(Object.hasOwn(process.env, "OPEN_SYNC_STRIPPED")))'],
    { env: { OPEN_SYNC_STRIPPED: undefined } },
  );
  assert.equal(child.code, 0);
  assert.equal(child.stdout, "false");
});
