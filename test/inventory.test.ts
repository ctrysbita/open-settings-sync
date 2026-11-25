import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  builtinInventory,
  machineSettings,
  machineSettingsFromDirectory,
} from "../src/editor/inventory";

test("machine scopes are found in single and grouped configuration contributions", () => {
  assert.deepEqual(
    machineSettings([
      {
        contributes: {
          configuration: { properties: { a: { scope: "machine" }, b: { scope: "resource" } } },
        },
      },
      { contributes: { configuration: [{ properties: { c: { scope: "machine-overridable" } } }] } },
      { contributes: { configuration: null } },
    ]),
    ["a", "c"],
  );
});

test("disabled extension manifests can protect machine settings without an active extension instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-manifests-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const folder = join(root, "extensions", "sample");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({
      name: "sample",
      contributes: { configuration: { properties: { "sample.executable": { scope: "machine" } } } },
    }),
  );
  assert.deepEqual(await machineSettingsFromDirectory(join(root, "extensions")), [
    "sample.executable",
  ]);
  assert.deepEqual(await builtinInventory(root), {
    extensions: ["undefined.sample"],
    machineSettings: ["sample.executable"],
  });
});

test("missing extension directories return empty and UTF-8 BOM manifests are parsed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-bom-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  assert.deepEqual(await machineSettingsFromDirectory(join(root, "absent")), []);
  const folder = join(root, "extensions", "bom-ext");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "package.json"),
    `\uFEFF${JSON.stringify({
      name: "bom-ext",
      contributes: { configuration: { properties: { "bom.path": { scope: "machine" } } } },
    })}`,
  );
  assert.deepEqual(await machineSettingsFromDirectory(join(root, "extensions")), ["bom.path"]);
});

test("corrupted user extension manifests warn and skip while builtin inspection stays strict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-corrupt-manifest-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const broken = join(root, "extensions", "broken-ext");
  const healthy = join(root, "extensions", "healthy-ext");
  await mkdir(broken, { recursive: true });
  await mkdir(healthy, { recursive: true });
  await writeFile(join(broken, "package.json"), "{not-json");
  await writeFile(
    join(healthy, "package.json"),
    JSON.stringify({
      name: "healthy-ext",
      contributes: { configuration: { properties: { "healthy.bin": { scope: "machine" } } } },
    }),
  );
  const warnings: string[] = [];
  assert.deepEqual(
    await machineSettingsFromDirectory(join(root, "extensions"), (message) =>
      warnings.push(message),
    ),
    ["healthy.bin"],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /broken-ext/);
  await assert.rejects(builtinInventory(root), { code: "invalid-data" });
});

test("symlinked extension directories are inspected for machine settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-symlink-manifest-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const target = join(root, "linked-target");
  const extensions = join(root, "extensions");
  await mkdir(target, { recursive: true });
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({
      name: "linked-ext",
      contributes: { configuration: { properties: { "linked.path": { scope: "machine" } } } },
    }),
  );
  try {
    await symlink(
      target,
      join(extensions, "linked-ext"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("symlink creation requires elevated permissions on this host");
      return;
    }
    throw error;
  }
  assert.deepEqual(await machineSettingsFromDirectory(extensions), ["linked.path"]);
});
