import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest, FileStore } from "../src/storage/files";

test("two windows cannot write the same sync store concurrently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-lock-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const first = new FileStore(root);
  const second = new FileStore(root);
  const entered = deferred();
  const finish = deferred();
  const active = first.exclusive(async (check) => {
    check();
    await access(join(root, "sync.lock"));
    await assert.rejects(access(`${root}.lock`), { code: "ENOENT" });
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  try {
    await assert.rejects(
      second.exclusive(async () => undefined),
      { code: "busy" },
    );
  } finally {
    finish.resolve();
    await active;
  }
  await assert.rejects(access(join(root, "sync.lock")), { code: "ENOENT" });
  await second.exclusive(async (check) => check());
});

test("baselines persist while backups stay bound to the selected settings source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-store-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const store = new FileStore(root);
  const snapshot = { version: 1 as const, settings: { font: 14 }, extensions: ["user.one"] };
  await store.saveBaseline("one", snapshot);
  assert.deepEqual(await store.baseline("one"), snapshot);
  await store.backup("file:///one", "// original\n{}");
  await store.backup("file:///two", "{}");
  const backups = await store.backups("file:///one");
  assert.equal(backups.length, 1);
  const first = backups[0];
  assert.ok(first);
  assert.equal((await store.readBackup("file:///one", first.name)).text, "// original\n{}");
  await assert.rejects(store.readBackup("file:///one", "../source.json"), {
    code: "invalid-data",
  });
});

test("corrupted backup files do not block listing healthy backups and old backups are pruned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-retention-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const store = new FileStore(root);
  await store.backup("file:///other", '{"other":true}');
  for (let index = 0; index < 23; index++) {
    await store.backup("file:///one", `{"index":${index}}`);
  }
  await writeFile(join(root, "backups", digest("file:///one"), "9999-corrupt.json"), "{invalid");
  const oneBackups = await store.backups("file:///one");
  assert.equal(oneBackups.length, 20);
  const otherBackups = await store.backups("file:///other");
  assert.equal(otherBackups.length, 1);
});

test("each settings URI keeps its profile bindings and only imports its own legacy source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-sources-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  const original = {
    uri: "file:///User/settings.json",
    userDataDirectory: root,
    editorProfile: "",
    extensionsDirectory: root,
  };
  const shared = { ...original, editorProfile: "Personal" };
  const work = {
    ...original,
    uri: "file:///User/profiles/work/settings.json",
    editorProfile: "Work",
  };
  await writeFile(join(root, "source.json"), JSON.stringify(original));
  assert.deepEqual(await store.sources(work.uri), []);
  assert.deepEqual(await store.sources(original.uri), [original]);
  await store.exclusive(async () => {
    await store.saveSource(work);
    await store.saveSource(shared);
    await store.saveSource(shared);
  });
  assert.deepEqual(await store.sources(work.uri), [work]);
  assert.deepEqual(await store.sources(original.uri), [original, shared]);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
