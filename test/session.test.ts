import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseSettings, patchSettings } from "../src/editor/settings-document";
import { FileStore } from "../src/storage/files";
import { SyncFailure } from "../src/sync/failure";
import type { SettingChange } from "../src/sync/merge";
import type { SyncPlan } from "../src/sync/session";
import { type LocalState, type SyncEnvironment, synchronize } from "../src/sync/session";
import { emptySnapshot, formatJson, type Settings } from "../src/sync/snapshot";
import { git, gitSandbox } from "./git-sandbox";

test("two machines keep independent settings edits and converge through a real Git remote", async (t) => {
  const sandbox = await gitSandbox(t);
  const first = new MemoryEditor({ font: 12, color: "blue", "api.token": "first-private" }, [
    "user.one",
  ]);
  const second = new MemoryEditor({ font: 12, color: "blue", "api.token": "second-private" }, [
    "user.two",
  ]);
  const a = environment(sandbox, "a", first, ["api.token"]);
  const b = environment(sandbox, "b", second, ["api.token"]);
  await synchronize(a);
  await synchronize(b);
  first.text = patchSettings(first.text, [{ key: "font", before: 12, after: 14 }]);
  second.text = patchSettings(second.text, [{ key: "color", before: "blue", after: "red" }]);
  await synchronize(b);
  await synchronize(a);
  await synchronize(b);
  assert.deepEqual((await first.read()).snapshot.settings, {
    font: 14,
    color: "red",
    "api.token": "first-private",
  });
  assert.deepEqual((await second.read()).snapshot.settings, {
    font: 14,
    color: "red",
    "api.token": "second-private",
  });
  assert.deepEqual((await a.repository.read()).snapshot, {
    version: 1,
    settings: { font: 14, color: "red" },
    extensions: ["user.one", "user.two"],
  });
  assert.equal((await a.persistence.backups(a.settingsUri)).length, 1);
});

test("a local uninstall reaches Git and the other profile only after each review is accepted", async (t) => {
  const sandbox = await gitSandbox(t);
  const first = new MemoryEditor({}, ["user.keep", "user.remove"]);
  const second = new MemoryEditor({});
  const a = environment(sandbox, "a", first);
  const b = environment(sandbox, "b", second);
  await synchronize(a);
  await synchronize(b);
  const previous = await b.repository.read();
  first.extensions.delete("user.remove");
  let approve = false;
  a.interaction.review = async (plan) => {
    assert.deepEqual(plan.gitRemovedExtensions, ["user.remove"]);
    assert.deepEqual(plan.installExtensions, []);
    assert.deepEqual(plan.uninstallExtensions, []);
    return approve;
  };
  assert.equal((await synchronize(a)).status, "cancelled");
  assert.deepEqual(await a.repository.read(), previous);
  approve = true;
  await synchronize(a);
  const published = await a.repository.read();
  assert.deepEqual(published.snapshot?.extensions, ["user.keep"]);

  approve = false;
  b.interaction.review = async (plan) => {
    assert.deepEqual(plan.uninstallExtensions, ["user.remove"]);
    assert.equal(plan.upload, false);
    return approve;
  };
  assert.equal((await synchronize(b)).status, "cancelled");
  assert.deepEqual([...second.extensions], ["user.keep", "user.remove"]);
  assert.deepEqual(await b.persistence.baseline(b.identity), previous.snapshot);
  approve = true;
  const result = await synchronize(b);
  assert.equal(result.uninstalledExtensions, 1);
  assert.deepEqual([...second.extensions], ["user.keep"]);
  assert.deepEqual(await b.persistence.baseline(b.identity), published.snapshot);
  assert.equal((await synchronize(b)).status, "unchanged");
  assert.deepEqual(await b.repository.read(), published);
});

test("cancelling a reviewed plan leaves Git local settings and baseline untouched", async (t) => {
  const sandbox = await gitSandbox(t);
  const editor = new MemoryEditor({ font: 14 });
  const env = environment(sandbox, "a", editor);
  env.interaction.review = async () => false;
  assert.equal((await synchronize(env)).status, "cancelled");
  assert.equal((await env.repository.read()).head, null);
  assert.equal(await env.persistence.baseline(env.identity), undefined);
  assert.equal(editor.applied, 0);
});

test("local edits during review abort before publishing any data", async (t) => {
  const sandbox = await gitSandbox(t);
  const editor = new MemoryEditor({ font: 14 });
  const env = environment(sandbox, "a", editor);
  env.interaction.review = async () => {
    editor.text = '{"font":18}';
    return true;
  };
  await assert.rejects(synchronize(env), { code: "local-changed" });
  assert.equal((await env.repository.read()).head, null);
  assert.deepEqual(parseSettings(editor.text), { font: 18 });
});

test("a failed publication never applies local settings or advances the baseline", async (t) => {
  const sandbox = await gitSandbox(t);
  const seed = sandbox.client("seed");
  await seed.publish(await seed.read(), {
    version: 1,
    settings: { remote: true },
    extensions: ["user.remote"],
  });
  const editor = new MemoryEditor({ local: true });
  const env = environment(sandbox, "a", editor);
  const broken: SyncEnvironment = {
    ...env,
    repository: {
      read: () => env.repository.read(),
      publish: async () => {
        throw new Error("offline");
      },
    },
  };
  await assert.rejects(synchronize(broken), /offline/);
  assert.equal(editor.applied, 0);
  assert.equal(editor.extensions.size, 0);
  assert.equal(await env.persistence.baseline(env.identity), undefined);
});

test("a failed extension installation applies settings, continues remaining extensions, and can be retried", async (t) => {
  const sandbox = await gitSandbox(t);
  const seed = sandbox.client("seed");
  await seed.publish(await seed.read(), {
    version: 1,
    settings: { font: 16 },
    extensions: ["user.one", "user.two", "user.three"],
  });
  const editor = new MemoryEditor({});
  editor.failInstallation = "user.two";
  const env = environment(sandbox, "a", editor);
  const first = await synchronize(env);
  assert.equal(first.status, "synced");
  assert.equal(first.settings, 1);
  assert.equal(first.extensions, 2);
  assert.deepEqual(
    first.failedExtensions.map((item) => item.id),
    ["user.two"],
  );
  assert.deepEqual((await editor.read()).snapshot.settings, { font: 16 });
  assert.deepEqual([...editor.extensions].sort(), ["user.one", "user.three"]);
  assert.deepEqual(await env.persistence.baseline(env.identity), {
    version: 1,
    settings: { font: 16 },
    extensions: ["user.one", "user.three"],
  });
  editor.failInstallation = undefined;
  const retry = await synchronize(env);
  assert.equal(retry.status, "synced");
  assert.equal(retry.settings, 0);
  assert.equal(retry.extensions, 1);
  assert.deepEqual(retry.failedExtensions, []);
  assert.deepEqual([...editor.extensions].sort(), ["user.one", "user.three", "user.two"]);
  assert.deepEqual(await env.persistence.baseline(env.identity), (await seed.read()).snapshot);
});

test("cancelling during extension installation stops remaining installs without advancing the baseline", async (t) => {
  const sandbox = await gitSandbox(t);
  const seed = sandbox.client("seed");
  await seed.publish(await seed.read(), {
    version: 1,
    settings: { font: 16 },
    extensions: ["user.one", "user.two"],
  });
  const editor = new MemoryEditor({});
  editor.failInstallation = "user.one";
  editor.failWith = new SyncFailure("cancelled", "Sync cancelled.");
  const env = environment(sandbox, "a", editor);
  await assert.rejects(synchronize(env), { code: "cancelled" });
  assert.deepEqual([...editor.extensions], []);
  assert.equal(await env.persistence.baseline(env.identity), undefined);
});

test("a failed uninstall is retried without adding it back to Git or repeating successful removals", async (t) => {
  const sandbox = await gitSandbox(t);
  const editor = new MemoryEditor({}, ["user.blocked", "user.removed"]);
  const env = environment(sandbox, "client", editor);
  await synchronize(env);
  await env.repository.publish(await env.repository.read(), emptySnapshot());
  editor.failUninstallation = "user.blocked";
  const result = await synchronize(env);
  assert.equal(result.uninstalledExtensions, 1);
  assert.deepEqual(
    result.failedExtensions.map(({ id, operation }) => [id, operation]),
    [["user.blocked", "uninstall"]],
  );
  assert.deepEqual((await env.persistence.baseline(env.identity))?.extensions, ["user.blocked"]);
  const originalHead = (await env.repository.read()).head;
  editor.failUninstallation = undefined;
  env.interaction.review = async (plan) => {
    assert.deepEqual(plan.uninstallExtensions, ["user.blocked"]);
    assert.equal(plan.upload, false);
    return true;
  };
  assert.equal((await synchronize(env)).uninstalledExtensions, 1);
  assert.deepEqual(await env.persistence.baseline(env.identity), emptySnapshot());
  assert.equal((await env.repository.read()).head, originalHead);
});

test("an uninstall that reports success but leaves the extension installed does not advance the baseline", async (t) => {
  const sandbox = await gitSandbox(t);
  const editor = new MemoryEditor({}, ["user.kept"]);
  const env = environment(sandbox, "client", editor);
  await synchronize(env);
  const previous = await env.repository.read();
  await env.repository.publish(previous, emptySnapshot());
  editor.uninstallExtension = async () => {};
  await assert.rejects(synchronize(env), { code: "verification-failed" });
  assert.deepEqual(await env.persistence.baseline(env.identity), previous.snapshot);
});

test("restoring an extension on Git during review prevents the pending uninstall", async (t) => {
  const sandbox = await gitSandbox(t);
  const editor = new MemoryEditor({}, ["user.restored"]);
  const env = environment(sandbox, "client", editor);
  await synchronize(env);
  const original = (await editor.read()).snapshot;
  await env.repository.publish(await env.repository.read(), emptySnapshot());
  env.interaction.review = async (plan) => {
    assert.deepEqual(plan.uninstallExtensions, ["user.restored"]);
    await env.repository.publish(await env.repository.read(), original);
    return true;
  };
  await assert.rejects(synchronize(env), { code: "remote-changed" });
  assert.deepEqual((await editor.read()).snapshot, original);
  assert.deepEqual(await env.persistence.baseline(env.identity), original);
});

test("extension removals preserve ignored, built-in and sync extensions on their respective sides", async (t) => {
  const sandbox = await gitSandbox(t);
  const protectedIds = [
    "ctrysbita.open-settings-sync",
    "private.local",
    "vendor.bundled",
    "vscode.git",
  ];
  const editor = new MemoryEditor({}, [...protectedIds, "user.remove"]);
  const env = environment(sandbox, "client", editor);
  await env.persistence.saveBaseline(env.identity, (await editor.read()).snapshot);
  const remote = { ...emptySnapshot(), extensions: ["private.remote"] };
  await env.repository.publish(await env.repository.read(), remote);
  env.interaction.review = async (plan) => {
    assert.deepEqual(plan.uninstallExtensions, ["user.remove"]);
    assert.deepEqual(plan.installExtensions, []);
    assert.equal(plan.upload, false);
    return true;
  };
  await synchronize({
    ...env,
    policy: {
      ...env.policy,
      builtinExtensions: ["vendor.bundled"],
      ignoredExtensions: ["private.*"],
    },
  });
  assert.deepEqual([...editor.extensions].sort(), protectedIds);
  assert.deepEqual((await env.repository.read()).snapshot, remote);
});

test("a concurrent remote update during preview cannot be overwritten", async (t) => {
  const sandbox = await gitSandbox(t);
  const seed = sandbox.client("seed");
  await seed.publish(await seed.read(), { version: 1, settings: { font: 12 }, extensions: [] });
  const editor = new MemoryEditor({ font: 12, local: true });
  const env = environment(sandbox, "a", editor);
  env.interaction.review = async () => {
    await seed.publish(await seed.read(), { version: 1, settings: { font: 18 }, extensions: [] });
    return true;
  };
  await assert.rejects(synchronize(env), { code: "remote-changed" });
  assert.equal(editor.applied, 0);
  assert.deepEqual((await seed.read()).snapshot?.settings, { font: 18 });
});

test("an already synchronized state is idempotent and still establishes a usable baseline", async (t) => {
  const sandbox = await gitSandbox(t);
  const editor = new MemoryEditor({ font: 14 });
  const env = environment(sandbox, "a", editor);
  await synchronize(env);
  const head = (await env.repository.read()).head;
  env.interaction.review = async () => {
    throw new Error("unexpected review");
  };
  assert.equal((await synchronize(env)).status, "unchanged");
  assert.equal((await env.repository.read()).head, head);
  editor.text = "{}";
  env.interaction.review = async () => true;
  await synchronize(env);
  assert.deepEqual((await env.repository.read()).snapshot?.settings, {});
});

for (const missing of ["branch", "collection"] as const) {
  test(`a missing ${missing} can be recreated from local settings only after explicit review`, async (t) => {
    const sandbox = await gitSandbox(t);
    const sibling = sandbox.client("sibling", "work");
    if (missing === "collection") await sibling.publish(await sibling.read(), emptySnapshot());
    const startingHead = (await sibling.read()).head;
    const editor = new MemoryEditor({ font: 14 }, ["user.keep"]);
    const env = environment(sandbox, "a", editor);
    await synchronize(env);
    const baseline = await env.persistence.baseline(env.identity);
    await git([
      `--git-dir=${sandbox.remote}`,
      "update-ref",
      ...(startingHead ? ["refs/heads/main", startingHead] : ["-d", "refs/heads/main"]),
    ]);
    editor.text = '{"font":18}';
    let approve = false;
    env.interaction.review = async (plan) => {
      assert.equal(plan.recreateCollection, true);
      assert.deepEqual(plan.settings, []);
      assert.deepEqual(plan.gitSettings, [{ key: "font", before: undefined, after: 18 }]);
      assert.deepEqual(plan.uninstallExtensions, []);
      assert.deepEqual(plan.gitExtensions, ["user.keep"]);
      return approve;
    };
    assert.equal((await synchronize(env)).status, "cancelled");
    assert.equal((await env.repository.read()).snapshot, null);
    assert.deepEqual(await env.persistence.baseline(env.identity), baseline);
    approve = true;
    await synchronize(env);
    assert.equal(editor.applied, 0);
    assert.deepEqual((await env.repository.read()).snapshot?.settings, { font: 18 });
    if (missing === "collection")
      assert.deepEqual((await sibling.read()).snapshot, emptySnapshot());
  });
}

test("a new profile with only local settings leaves an absent collection uninitialized", async (t) => {
  const sandbox = await gitSandbox(t);
  const editor = new MemoryEditor({
    "rest-client.defaultHeaders": { "X-API-Key": "local fixture" },
  });
  const env = environment(sandbox, "a", editor, ["rest-client.defaultHeaders"]);
  env.interaction.review = async () => {
    throw new Error("Unexpected upload");
  };
  assert.equal((await synchronize(env)).status, "unchanged");
  assert.equal((await env.repository.read()).head, null);
  assert.equal(await env.persistence.baseline(env.identity), undefined);
});

test("an existing empty snapshot propagates deletions and keeps a real empty baseline", async (t) => {
  const sandbox = await gitSandbox(t);
  const editor = new MemoryEditor({ font: 14 });
  const env = environment(sandbox, "a", editor);
  await synchronize(env);
  await env.repository.publish(await env.repository.read(), emptySnapshot());
  env.interaction.review = async (plan) => {
    assert.equal(plan.recreateCollection, false);
    assert.deepEqual(plan.settings, [{ key: "font", before: 14, after: undefined }]);
    return true;
  };
  await synchronize(env);
  assert.deepEqual((await editor.read()).snapshot, emptySnapshot());
  assert.deepEqual(await env.persistence.baseline(env.identity), emptySnapshot());
  await git([`--git-dir=${sandbox.remote}`, "update-ref", "-d", "refs/heads/main"]);
  env.interaction.review = async (plan) => {
    assert.equal(plan.recreateCollection, true);
    return false;
  };
  assert.equal((await synchronize(env)).status, "cancelled");
});

test("the preview includes outbound setting values before a first upload", async (t) => {
  const sandbox = await gitSandbox(t);
  const headers = { "X-API-Key": "local fixture" };
  const editor = new MemoryEditor(
    {
      font: 14,
      "api.token": "fixture",
      "rest-client.defaultHeaders": headers,
    },
    ["user.one"],
  );
  const env = environment(sandbox, "a", editor);
  let reviewed = false;
  env.interaction.review = async (plan) => {
    reviewed = true;
    assert.deepEqual(plan.settings, []);
    assert.deepEqual(plan.gitSettings, [
      { key: "font", before: undefined, after: 14 },
      { key: "api.token", before: undefined, after: "fixture" },
      { key: "rest-client.defaultHeaders", before: undefined, after: headers },
    ]);
    assert.deepEqual(plan.gitExtensions, ["user.one"]);
    return false;
  };
  await synchronize(env);
  assert.equal(reviewed, true);
  assert.equal((await env.repository.read()).head, null);
});

test("removing ignore rules syncs previously excluded cookie headers in both directions", async (t) => {
  const sandbox = await gitSandbox(t);
  const preference = "rest-client.rememberCookiesForSubsequentRequests";
  const local = {
    "rest-client.defaultHeaders": { cOoKiE: "local fixture", Accept: "text/plain" },
    [preference]: true,
  };
  const remote = { "client.responses": [{ headers: { "SeT-CooKie": "remote fixture" } }] };
  const editor = new MemoryEditor(local);
  const env = environment(sandbox, "client", editor, ["Cookie", "Set-Cookie"]);
  await env.repository.publish(await env.repository.read(), {
    version: 1,
    settings: remote,
    extensions: [],
  });
  env.interaction.review = async (plan) => {
    assert.deepEqual(plan.settings, []);
    assert.deepEqual(plan.gitSettings, [{ key: preference, before: undefined, after: true }]);
    return true;
  };
  assert.equal((await synchronize(env)).status, "synced");
  assert.deepEqual((await editor.read()).snapshot.settings, local);
  assert.deepEqual((await env.repository.read()).snapshot?.settings, {
    ...remote,
    [preference]: true,
  });
  assert.deepEqual((await env.persistence.baseline(env.identity))?.settings, {
    [preference]: true,
  });

  const unfiltered = environment(sandbox, "client", editor);
  assert.equal((await synchronize(unfiltered)).status, "synced");
  const merged = { ...local, ...remote };
  assert.deepEqual((await editor.read()).snapshot.settings, merged);
  assert.deepEqual((await unfiltered.repository.read()).snapshot?.settings, merged);
  assert.deepEqual((await unfiltered.persistence.baseline(unfiltered.identity))?.settings, merged);
});

test("a file association reorder reaches the other machine through Git and the persisted baseline", async (t) => {
  const sandbox = await gitSandbox(t);
  const key = "files.associations";
  const original = { "abc.*": "javascript", "*.foo": "plaintext" };
  const reversed = { "*.foo": "plaintext", "abc.*": "javascript" };
  const first = new MemoryEditor({ [key]: original });
  const second = new MemoryEditor({});
  const a = environment(sandbox, "a", first);
  const b = environment(sandbox, "b", second);
  await synchronize(a);
  await synchronize(b);
  assert.equal(JSON.stringify(parseSettings(second.text)[key]), JSON.stringify(original));
  second.text = patchSettings(second.text, [{ key, before: original, after: reversed }]);
  await synchronize(b);
  await synchronize(a);
  assert.equal(JSON.stringify(parseSettings(first.text)[key]), JSON.stringify(reversed));
  const baseline = await a.persistence.baseline(a.identity);
  assert.equal(JSON.stringify(baseline?.settings[key]), JSON.stringify(reversed));
});

test("an order-only edit is previewed, backed up and applied once across a Git round trip", async (t) => {
  const sandbox = await gitSandbox(t);
  const first = new MemoryEditor({});
  const second = new MemoryEditor({});
  const rules = '{"levels":[{"20":"twenty","1":"one","02":"two"}]}';
  first.text = `{"z":${rules},"a":2,"m":3}`;
  second.text = `{\n  // rule list\n  "z":${rules},\n  "local.only":42,\n  "a":2,\n  "m":3\n}`;
  const a = environment(sandbox, "a", first);
  const b = environment(sandbox, "b", second, ["local.only"]);
  await synchronize(a);
  await synchronize(b);
  const original = second.text;
  const initial = await b.persistence.baseline(b.identity);
  assert.equal(JSON.stringify(initial?.settings), first.text);
  first.text = `{"m":3,"z":${rules},"a":2}`;
  a.interaction.review = async (plan) => {
    assert.deepEqual(plan.gitSettings, []);
    assert.deepEqual(plan.gitSettingsOrder, ["m", "z", "a"]);
    return true;
  };
  await synchronize(a);
  const published = await git([
    `--git-dir=${sandbox.remote}`,
    "show",
    "refs/heads/main:.settings-sync/main.json",
  ]);
  assert.match(published, /"20": "twenty",\s*"1": "one",\s*"02": "two"/);
  let approve = false;
  b.interaction.review = async (plan) => {
    assert.deepEqual(plan.settings, []);
    assert.deepEqual(plan.settingsOrder, ["m", "z", "a"]);
    assert.equal(plan.upload, false);
    return approve;
  };
  assert.equal((await synchronize(b)).status, "cancelled");
  assert.equal(second.text, original);
  approve = true;
  await synchronize(b);
  assert.equal(
    second.text,
    `{\n  "m":3,\n  "local.only":42,\n  // rule list\n  "z":${rules},\n  "a":2\n}`,
  );
  const [backup] = await b.persistence.backups(b.settingsUri);
  assert.ok(backup);
  assert.equal((await b.persistence.readBackup(b.settingsUri, backup.name)).text, original);
  assert.equal(JSON.stringify((await b.persistence.baseline(b.identity))?.settings), first.text);
  const head = (await b.repository.read()).head;
  assert.equal((await synchronize(b)).status, "unchanged");
  assert.equal((await b.repository.read()).head, head);
});

test("settings-only sync verifies via lightweight readSettings without re-listing extensions", async (t) => {
  const sandbox = await gitSandbox(t);
  const seed = sandbox.client("seed");
  await seed.publish(await seed.read(), { version: 1, settings: { font: 16 }, extensions: [] });
  const editor = new MemoryEditor({});
  const env = environment(sandbox, "a", editor);
  const result = await synchronize(env);
  assert.equal(result.status, "synced");
  assert.equal(editor.readCount, 2);
  assert.equal(editor.readSettingsCount, 1);
});

test("verification failures report mismatched keys without leaking setting values", async (t) => {
  const sandbox = await gitSandbox(t);
  const seed = sandbox.client("seed");
  await seed.publish(await seed.read(), {
    version: 1,
    settings: { "editor.fontSize": 18 },
    extensions: [],
  });
  const editor = new MemoryEditor({});
  const env = environment(sandbox, "a", editor);
  const broken: SyncEnvironment = {
    ...env,
    editor: {
      read: () => editor.read(),
      readSettings: async () => ({ "editor.fontSize": 99 }),
      applySettings: (expected, changes, order) => editor.applySettings(expected, changes, order),
      installExtension: (id) => editor.installExtension(id),
      uninstallExtension: (id) => editor.uninstallExtension(id),
    },
  };
  await assert.rejects(synchronize(broken), (error: unknown) => {
    assert.ok(error instanceof SyncFailure);
    assert.equal(error.code, "verification-failed");
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /editor\.fontSize/);
    assert.doesNotMatch(error.cause.message, /99|18/);
    return true;
  });
  assert.equal(await env.persistence.baseline(env.identity), undefined);
});

class MemoryEditor {
  text: string;
  readonly extensions: Set<string>;
  failInstallation: string | undefined;
  failUninstallation: string | undefined;
  failWith: Error | undefined;
  applied = 0;
  readCount = 0;
  readSettingsCount = 0;

  constructor(settings: Settings, extensions: readonly string[] = []) {
    this.text = formatJson(settings);
    this.extensions = new Set(extensions);
  }

  async readSettings(): Promise<Settings> {
    this.readSettingsCount++;
    return parseSettings(this.text);
  }

  async read(): Promise<LocalState> {
    this.readCount++;
    return {
      settingsText: this.text,
      snapshot: {
        version: 1,
        settings: parseSettings(this.text),
        extensions: [...this.extensions].sort(),
      },
    };
  }

  async installExtension(id: string): Promise<void> {
    if (id === this.failInstallation) throw this.failWith ?? new Error("installation failed");
    this.extensions.add(id);
  }

  async uninstallExtension(id: string): Promise<void> {
    if (id === this.failUninstallation) throw new Error("uninstallation failed");
    this.extensions.delete(id);
  }

  async applySettings(
    expected: string,
    changes: readonly SettingChange[],
    order?: readonly string[],
  ): Promise<void> {
    assert.equal(this.text, expected);
    this.text = patchSettings(this.text, changes, order);
    this.applied++;
  }
}

function environment(
  sandbox: Awaited<ReturnType<typeof gitSandbox>>,
  name: string,
  editor: MemoryEditor,
  ignoredSettings: readonly string[] = [],
) {
  return {
    identity: "main",
    settingsUri: `test:///${name}`,
    policy: {
      builtinExtensions: [],
      machineSettings: [],
      ignoredSettings,
      ignoredExtensions: [],
      ownExtension: "ctrysbita.open-settings-sync",
    },
    editor,
    repository: sandbox.client(name),
    persistence: new FileStore(join(sandbox.root, `${name}-state`)),
    interaction: {
      async resolve() {
        return undefined;
      },
      async review(_plan: SyncPlan) {
        return true;
      },
    },
    check() {},
  };
}
