import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { GitRepository, validateRemote } from "../src/git/repository";
import type { Snapshot } from "../src/sync/snapshot";
import { git, gitSandbox } from "./git-sandbox";

test("an empty remote can be initialized and another client reads the published snapshot", async (t) => {
  const sandbox = await gitSandbox(t);
  const first = sandbox.client("first");
  const initial = await first.read();
  assert.equal(initial.head, null);
  assert.equal(initial.snapshot, null);
  await first.publish(initial, snapshot({ font: 14 }, ["user.one"]));
  assert.deepEqual(
    (await sandbox.client("second").read()).snapshot,
    snapshot({ font: 14 }, ["user.one"]),
  );
});

test("publishing one collection preserves every other collection", async (t) => {
  const sandbox = await gitSandbox(t);
  const main = sandbox.client("first");
  await main.publish(await main.read(), snapshot({ font: 14 }));
  const other = sandbox.client("other", "work");
  assert.equal((await other.read()).snapshot, null);
  await other.publish(await other.read(), snapshot({ font: 18 }));
  assert.deepEqual((await main.read()).snapshot?.settings, { font: 14 });
  assert.deepEqual((await other.read()).snapshot?.settings, { font: 18 });
});

test("a stale reviewed commit cannot overwrite a concurrent push", async (t) => {
  const sandbox = await gitSandbox(t);
  const first = sandbox.client("first");
  await first.publish(await first.read(), snapshot({ font: 12 }));
  const stale = await first.read();
  const second = sandbox.client("second");
  await second.publish(await second.read(), snapshot({ font: 14 }));
  await assert.rejects(first.publish(stale, snapshot({ font: 16 })), { code: "remote-changed" });
  assert.deepEqual((await first.read()).snapshot?.settings, { font: 14 });
});

for (const change of ["rewind", "delete"] as const) {
  test(`a branch ${change} after the final read is respected by the push`, async (t) => {
    const sandbox = await gitSandbox(t);
    const client = sandbox.client("writer");
    await client.publish(await client.read(), snapshot({ font: 12 }));
    const original = await client.read();
    assert.ok(original.head);
    const firstHead = original.head;
    await client.publish(original, snapshot({ font: 14 }));
    const reviewed = await client.read();
    assert.ok(reviewed.head);
    const reviewedHead = reviewed.head;
    const readHead = client.readHead.bind(client);
    t.mock.method(
      client,
      "readHead",
      async () => {
        const seen = await readHead();
        const update =
          change === "delete"
            ? ["-d", "refs/heads/main", reviewedHead]
            : ["refs/heads/main", firstHead, reviewedHead];
        await git([`--git-dir=${sandbox.remote}`, "update-ref", ...update]);
        return seen;
      },
      { times: 1 },
    );
    await assert.rejects(client.publish(reviewed, snapshot({ font: 16 })), {
      code: "remote-changed",
    });
    assert.equal(await readHead(), change === "delete" ? null : firstHead);
  });
}

test("transport failures during push are classified as process-failed rather than remote-changed", async (t) => {
  const sandbox = await gitSandbox(t);
  const client = sandbox.client("writer");
  const initial = await client.read();
  const readHead = client.readHead.bind(client);
  t.mock.method(
    client,
    "readHead",
    async () => {
      const seen = await readHead();
      await rm(sandbox.remote, { recursive: true, force: true });
      return seen;
    },
    { times: 1 },
  );
  await assert.rejects(client.publish(initial, snapshot({ font: 14 })), {
    code: "process-failed",
  });
});

test("a symlink used as the remote snapshot is rejected without following it", async (t) => {
  const sandbox = await gitSandbox(t);
  const directory = sandbox.remote;
  const blob = await git([`--git-dir=${directory}`, "hash-object", "-w", "--stdin"], "/etc/passwd");
  const childTree = await git(
    [`--git-dir=${directory}`, "mktree"],
    `120000 blob ${blob}\tmain.json\n`,
  );
  const rootTree = await git(
    [`--git-dir=${directory}`, "mktree"],
    `040000 tree ${childTree}\t.settings-sync\n`,
  );
  const commit = await git([`--git-dir=${directory}`, "commit-tree", rootTree], "test\n");
  await git([`--git-dir=${directory}`, "update-ref", "refs/heads/main", commit]);
  await assert.rejects(sandbox.client("first").read(), { code: "invalid-data" });
});

test("unsupported remote versions fail before any publication", async (t) => {
  const sandbox = await gitSandbox(t);
  const directory = sandbox.remote;
  const blob = await git(
    [`--git-dir=${directory}`, "hash-object", "-w", "--stdin"],
    '{"version":99}',
  );
  const childTree = await git(
    [`--git-dir=${directory}`, "mktree"],
    `100644 blob ${blob}\tmain.json\n`,
  );
  const rootTree = await git(
    [`--git-dir=${directory}`, "mktree"],
    `040000 tree ${childTree}\t.settings-sync\n`,
  );
  const commit = await git([`--git-dir=${directory}`, "commit-tree", rootTree], "test\n");
  await git([`--git-dir=${directory}`, "update-ref", "refs/heads/main", commit]);
  await assert.rejects(sandbox.client("first").read(), { code: "invalid-data" });
});

test("shallow fetches over file URL transport can publish sequential updates", async (t) => {
  const sandbox = await gitSandbox(t);
  const remoteUrl = pathToFileURL(sandbox.remote).href;
  const first = new GitRepository({
    directory: join(sandbox.root, "url-first"),
    remote: remoteUrl,
    branch: "main",
    profile: "main",
    git: "git",
  });
  const second = new GitRepository({
    directory: join(sandbox.root, "url-second"),
    remote: remoteUrl,
    branch: "main",
    profile: "main",
    git: "git",
  });
  await first.publish(await first.read(), snapshot({ font: 12 }));
  const state = await second.read();
  assert.deepEqual(state.snapshot?.settings, { font: 12 });
  await second.publish(state, snapshot({ font: 16 }));
  assert.deepEqual((await first.read()).snapshot?.settings, { font: 16 });
});

test("command transports embedded credentials and unsafe profile paths are rejected", () => {
  for (const remote of [
    "ext::arbitrary-command",
    "fd::1",
    "--upload-pack=bad",
    "https://token@host/repo.git",
    "http://github.com/owner/repo.git",
    "git://github.com/owner/repo.git",
    "git@host:path\nother",
    "C:relative/repo.git",
  ]) {
    assert.throws(() => validateRemote(remote), `expected rejection for ${remote}`);
  }
  for (const remote of [
    "git@github.com:owner/repo.git",
    "git@github.com:owner/c++-settings.git",
    "github-work:owner/repo.git",
    "https://github.com/owner/repo.git",
    "ssh://git@github.com:22/owner/repo.git",
  ]) {
    assert.doesNotThrow(() => validateRemote(remote), `expected acceptance for ${remote}`);
  }
  assert.throws(
    () =>
      new GitRepository({
        directory: "/tmp/cache",
        remote: "/tmp/remote",
        branch: "main",
        profile: "../escape",
        git: "git",
      }),
  );
});

function snapshot(settings: Snapshot["settings"], extensions: readonly string[] = []): Snapshot {
  return { version: 1, settings, extensions };
}
