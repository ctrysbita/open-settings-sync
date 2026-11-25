import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSnapshots, settingChanges } from "../src/sync/merge";
import {
  createPolicy,
  isInternalExtensionId,
  isValidBranchName,
  isValidProfileName,
  matchWildcard,
  type PolicyOptions,
} from "../src/sync/policy";
import { decodeSnapshot, emptySnapshot, formatJson, type Snapshot } from "../src/sync/snapshot";

const policyOptions: PolicyOptions = {
  builtinExtensions: ["vendor.internal"],
  machineSettings: ["tools.executable"],
  ignoredSettings: ["local.*"],
  ignoredExtensions: ["private.*"],
  ownExtension: "ctrysbita.open-settings-sync",
};

test("independent setting edits merge and remote deletions propagate", () => {
  const result = mergeSnapshots(
    snapshot({ font: 12, color: "blue", removed: true }),
    snapshot({ font: 14, color: "blue", removed: true }),
    snapshot({ font: 12, color: "red" }),
  );
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.snapshot.settings, { font: 14, color: "red" });
  assert.deepEqual(settingChanges({ removed: true }, {}), [
    { key: "removed", before: true, after: undefined },
  ]);
});

test("conflicting edits and deletion versus change require an explicit decision", () => {
  const base = snapshot({ font: 12 });
  const local = snapshot({});
  const remote = snapshot({ font: 16 });
  const unresolved = mergeSnapshots(base, local, remote);
  assert.deepEqual(unresolved.conflicts, [{ key: "font", base: 12, local: undefined, remote: 16 }]);
  assert.deepEqual(
    mergeSnapshots(base, local, remote, new Map([["font", "remote"]])).snapshot.settings,
    { font: 16 },
  );
  assert.deepEqual(
    mergeSnapshots(base, local, remote, new Map([["font", "local"]])).snapshot.settings,
    {},
  );
});

test("the first sync combines disjoint settings and preserves all user extension wishes", () => {
  const merged = mergeSnapshots(
    emptySnapshot(),
    snapshot({ font: 12 }, ["user.one"]),
    snapshot({ color: "red" }, ["user.two"]),
  );
  assert.deepEqual(merged.snapshot, snapshot({ color: "red", font: 12 }, ["user.one", "user.two"]));
  assert.equal(merged.conflicts.length, 0);
});

test("object and array order are meaningful and null is distinct from deletion", () => {
  assert.notEqual(formatJson({ b: 2, a: 1 }), formatJson({ a: 1, b: 2 }));
  assert.equal(settingChanges({ key: { a: 1, b: 2 } }, { key: { b: 2, a: 1 } }).length, 1);
  assert.equal(settingChanges({ key: [1, 2] }, { key: [2, 1] }).length, 1);
  assert.equal(settingChanges({ key: null }, {}).length, 1);
});

test("file association priority survives decoding, serialization and order-only merges", () => {
  const original = { "abc.*": "javascript", "*.foo": "plaintext" };
  const reordered = { "*.foo": "plaintext", "abc.*": "javascript" };
  const base = snapshot({ "files.associations": original });
  const remote = snapshot({ "files.associations": reordered });
  const roundTrip = decodeSnapshot(JSON.parse(formatJson(base)));
  assert.equal(JSON.stringify(roundTrip.settings["files.associations"]), JSON.stringify(original));
  const merged = mergeSnapshots(base, base, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(
    JSON.stringify(merged.snapshot.settings["files.associations"]),
    JSON.stringify(reordered),
  );
  assert.deepEqual(
    settingChanges(base.settings, merged.snapshot.settings).map((change) => change.key),
    ["files.associations"],
  );
});

test("independent insertions retain each side's order around shared settings", () => {
  const result = mergeSnapshots(
    snapshot({ z: 0, a: 1 }),
    snapshot({ first: 2, z: 0, local: 3, a: 1 }),
    snapshot({ z: 0, remote: 4, a: 1, last: 5 }),
  );
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.snapshot.settings), [
    "first",
    "z",
    "remote",
    "local",
    "a",
    "last",
  ]);
});

test("incompatible top-level orders require a choice that preserves independent value edits", () => {
  const base = snapshot({ a: 1, b: 2, c: 3 });
  const local = snapshot({ c: 3, a: 10, b: 2 });
  const remote = snapshot({ b: 20, a: 1, c: 3 });
  assert.deepEqual(mergeSnapshots(base, local, remote).conflicts, [
    {
      key: null,
      base: ["a", "b", "c"],
      local: ["c", "a", "b"],
      remote: ["b", "a", "c"],
    },
  ]);
  for (const choice of ["local", "remote"] as const) {
    const result = mergeSnapshots(base, local, remote, new Map([[null, choice]]));
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(
      Object.keys(result.snapshot.settings),
      Object.keys(choice === "local" ? local.settings : remote.settings),
    );
    assert.deepEqual(result.snapshot.settings, { a: 10, b: 20, c: 3 });
  }
});

test("internal extensions and machine-only or ignored settings stay out of the local apply plan", () => {
  const remote = snapshot(
    {
      font: 14,
      "openSettingsSync.git.remote": "private",
      "settingsSync.ignoredSettings": ["a"],
      "cursorAuth.session": "local fixture",
      "tools.executable": "/machine/path",
      "local.only": true,
    },
    [
      "vendor.internal",
      "anysphere.cursor-always-local",
      "cursor.cursor-browser",
      "vscode.git",
      "user.good",
      "private.one",
    ],
  );
  const policy = createPolicy(policyOptions, [remote]);
  assert.deepEqual(policy.select(remote), snapshot({ font: 14 }, ["user.good"]));
  const retained = policy.retainRemote(remote, policy.select(remote));
  assert.equal(retained.settings["local.only"], true);
  assert.deepEqual(retained.extensions, [...remote.extensions].sort());
});

test("a bundled extension stays in Git for editors that install it separately", () => {
  const id = "ms-toolsai.jupyter-keymap";
  const shared = snapshot({}, [id]);
  const local = snapshot({}, ["vendor.extra"]);
  const cursor = createPolicy({ ...policyOptions, builtinExtensions: [id] }, [local, shared]);
  const merged = mergeSnapshots(emptySnapshot(), cursor.select(local), cursor.select(shared));
  assert.deepEqual(merged.snapshot.extensions, ["vendor.extra"]);
  const published = cursor.retainRemote(shared, merged.snapshot);
  const vscode = createPolicy(policyOptions, [published]);
  assert.deepEqual(vscode.select(published).extensions, [id, "vendor.extra"]);
});

test("retaining ignored settings keeps their positions while applying the selected order", () => {
  const remote = snapshot({ z: 1, "local.first": 2, a: 3, "local.last": 4, m: 5 });
  const policy = createPolicy(policyOptions, [remote]);
  const selected = policy.select(remote);
  assert.equal(
    JSON.stringify(policy.retainRemote(remote, selected).settings),
    JSON.stringify(remote.settings),
  );
  const target = policy.retainRemote(remote, snapshot({ m: 50, a: 30, z: 10 }));
  assert.deepEqual(Object.entries(target.settings), [
    ["m", 50],
    ["local.first", 2],
    ["a", 30],
    ["local.last", 4],
    ["z", 10],
  ]);
});

test("an explicit nested ignore rule keeps the entire setting local on both sides", () => {
  const local = snapshot({ headers: { Authorization: "fixture", mode: "a" }, font: 12 });
  const remote = snapshot({ headers: { mode: "b" }, font: 14 });
  const policy = createPolicy({ ...policyOptions, ignoredSettings: ["headers.author*"] }, [
    local,
    remote,
  ]);
  assert.deepEqual(policy.select(local).settings, { font: 12 });
  assert.deepEqual(policy.select(remote).settings, { font: 14 });
  assert.deepEqual(policy.retainRemote(remote, policy.select(local)).settings.headers, {
    mode: "b",
  });
});

test("credential-like names in top-level settings and nested objects sync by default", () => {
  const local = snapshot({
    "editor.tokenColorCustomizations": { comments: "#888888" },
    "example.passwordHint": true,
    "example.secretLabel": "caption",
    "example.credentialProvider": "example",
    "rest-client.defaultHeaders": [
      { "X-API-Key": "fixture", Authorization: "fixture", "private-key": "fixture" },
    ],
  });
  const policy = createPolicy(policyOptions, [local]);
  assert.deepEqual(policy.select(local), local);
});

test("unsupported snapshots are rejected and extension identifiers are normalized", () => {
  assert.throws(() => decodeSnapshot({ version: 2, settings: {}, extensions: [] }));
  assert.throws(() => decodeSnapshot({ version: 1, settings: {}, extensions: [], builtin: {} }));
  assert.throws(() => decodeSnapshot({ version: 1, settings: {}, extensions: ["--unsafe"] }));
  assert.throws(() => decodeSnapshot({ version: 1, settings: {}, extensions: ["--unsafe.ext"] }));
  assert.throws(() => decodeSnapshot({ version: 1, settings: {}, extensions: ["pub.-ext"] }));
  assert.deepEqual(
    decodeSnapshot({ version: 1, settings: {}, extensions: ["User.One", "user.one"] }).extensions,
    ["user.one"],
  );
});

test("wildcard matching is case-insensitive and avoids backtracking on repeated stars", () => {
  assert.equal(matchWildcard("Editor.FontSize", "editor.*size"), true);
  assert.equal(matchWildcard("my.setting.key", "my.*.other"), false);
  assert.equal(matchWildcard(`${"a".repeat(60)}b`, `${"*a".repeat(20)}*c`), false);
  assert.equal(isValidProfileName("main-profile_1"), true);
  assert.equal(isValidProfileName("../escape"), false);
  assert.equal(isValidBranchName("feature/sync-v1"), true);
  assert.equal(isValidBranchName("-bad"), false);
  assert.equal(isInternalExtensionId("VSCode.git"), true);
  assert.equal(isInternalExtensionId("anysphere.cursor-mcp"), true);
  assert.equal(isInternalExtensionId("user.extension"), false);
});

function snapshot(settings: Snapshot["settings"], extensions: readonly string[] = []): Snapshot {
  return { version: 1, settings, extensions };
}
