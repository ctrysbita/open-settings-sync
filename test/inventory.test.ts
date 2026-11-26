import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  builtinInventory,
  type InventoryOptions,
  installedExtensions,
  installInProfile,
  machineSettings,
  uninstallInProfile,
  userExtensionManifests,
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
  assert.deepEqual(machineSettings(await userExtensionManifests(join(root, "extensions"))), [
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
  assert.deepEqual(await userExtensionManifests(join(root, "absent")), []);
  const folder = join(root, "extensions", "bom-ext");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "package.json"),
    `\uFEFF${JSON.stringify({
      name: "bom-ext",
      contributes: { configuration: { properties: { "bom.path": { scope: "machine" } } } },
    })}`,
  );
  assert.deepEqual(machineSettings(await userExtensionManifests(join(root, "extensions"))), [
    "bom.path",
  ]);
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
    machineSettings(
      await userExtensionManifests(join(root, "extensions"), (message) => warnings.push(message)),
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
  assert.deepEqual(machineSettings(await userExtensionManifests(extensions)), ["linked.path"]);
});

test("installedExtensions parses versioned CLI output, normalizes IDs, and rejects malformed lines", async (t) => {
  const cli = await fakeEditorCli(t, {
    listOutput: "User.Beta@2.0.0\r\n\r\nuser.alpha@1.0.0-pre.1\n",
  });
  assert.deepEqual(await installedExtensions(cli.options), ["user.alpha", "user.beta"]);
  assert.deepEqual(await cli.calls(), [
    [
      "--list-extensions",
      "--show-versions",
      "--user-data-dir",
      cli.options.source.userDataDirectory,
      "--profile=Work",
      "--extensions-dir",
      cli.options.source.extensionsDirectory,
    ],
  ]);

  await cli.setState({ listOutput: "user.alpha\n" });
  await assert.rejects(installedExtensions(cli.options), { code: "invalid-data" });

  await cli.setState({ listOutput: "user.alpha@1.0.0@extra\n" });
  await assert.rejects(installedExtensions(cli.options), { code: "invalid-data" });

  await cli.setState({ listExitCode: 2, listStderr: "profile not found" });
  await assert.rejects(installedExtensions(cli.options), { code: "process-failed" });
});

test("installInProfile normalizes IDs, accepts absolute VSIX paths, and blocks invalid or .vsix IDs", async (t) => {
  const cli = await fakeEditorCli(t, {});
  await assert.rejects(installInProfile(cli.options, "--flag"), { code: "invalid-data" });
  await assert.rejects(installInProfile(cli.options, "./local.vsix"), { code: "invalid-data" });
  await assert.rejects(installInProfile(cli.options, "Publisher.VSIX"), { code: "process-failed" });
  assert.deepEqual(await cli.calls(), []);

  await installInProfile(cli.options, "User.Target");
  const vsix = join(cli.options.appRoot, "Fixture.VSIX");
  await installInProfile(cli.options, vsix);
  const calls = await cli.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.slice(0, 2), ["--install-extension", "user.target"]);
  assert.deepEqual(calls[1]?.slice(0, 2), ["--install-extension", vsix]);
});

test("uninstallInProfile blocks unapproved, invalid, and .vsix IDs before invoking the CLI", async (t) => {
  const cli = await fakeEditorCli(t, { listOutput: "publisher.vsix@1.0.0\nuser.one@1.0.0\n" });
  await assert.rejects(uninstallInProfile(cli.options, "user.one", new Set(), []), {
    code: "invalid-data",
  });
  await assert.rejects(uninstallInProfile(cli.options, "--flag", new Set(["--flag"]), []), {
    code: "invalid-data",
  });
  await assert.rejects(
    uninstallInProfile(cli.options, "Publisher.VSIX", new Set(["publisher.vsix"]), []),
    { code: "process-failed" },
  );
  assert.deepEqual(await cli.calls(), []);
});

test("uninstallInProfile normalizes case and skips extensions already removed by an earlier pack", async (t) => {
  const cli = await fakeEditorCli(t, { listOutput: "User.Target@1.0.0\n" });
  const manifests = [{ publisher: "User", name: "Target", version: "1.0.0" }];
  await uninstallInProfile(cli.options, "User.Target", new Set(["USER.TARGET"]), manifests);
  const callsAfterUninstall = await cli.calls();
  assert.equal(callsAfterUninstall.length, 2);
  assert.deepEqual(callsAfterUninstall[1]?.slice(0, 2), ["--uninstall-extension", "user.target"]);

  await cli.setState({ listOutput: "" });
  await uninstallInProfile(cli.options, "user.gone", new Set(["user.gone"]), []);
  const callsAfterSkip = await cli.calls();
  assert.equal(callsAfterSkip.length, 3);
  assert.equal(callsAfterSkip[2]?.[0], "--list-extensions");
});

test("uninstallInProfile checks transitive extension packs, cycles, active versions, and malformed manifests", async (t) => {
  const cli = await fakeEditorCli(t, {
    listOutput: "pack.root@1.0.0\npack.mid@1.0.0\npack.leaf@1.0.0\n",
  });
  const manifests = [
    { publisher: "pack", name: "root", version: "0.9.0", extensionPack: ["user.unapproved"] },
    {
      publisher: "pack",
      name: "root",
      version: "1.0.0",
      extensionPack: ["Pack.Mid", "pack.absent"],
    },
    { publisher: "pack", name: "mid", version: "1.0.0", extensionPack: ["pack.root", "pack.leaf"] },
    { publisher: "pack", name: "leaf", version: "1.0.0" },
  ];

  await assert.rejects(
    uninstallInProfile(cli.options, "pack.root", new Set(["pack.root", "pack.mid"]), manifests),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "process-failed" &&
      /pack\.leaf/.test(error.message),
  );
  assert.equal(
    (await cli.calls()).every((args) => args[0] !== "--uninstall-extension"),
    true,
  );

  await uninstallInProfile(
    cli.options,
    "pack.root",
    new Set(["pack.root", "pack.mid", "pack.leaf"]),
    manifests,
  );
  assert.deepEqual((await cli.calls()).at(-1)?.slice(0, 2), ["--uninstall-extension", "pack.root"]);

  await assert.rejects(
    uninstallInProfile(
      cli.options,
      "pack.root",
      new Set(["pack.root", "pack.mid", "pack.leaf"]),
      manifests.filter((item) => !(item.name === "leaf" && item.version === "1.0.0")),
    ),
    { code: "process-failed" },
  );

  await assert.rejects(
    uninstallInProfile(cli.options, "pack.leaf", new Set(["pack.leaf"]), [
      { publisher: "pack", name: "leaf", version: "1.0.0", extensionPack: null },
    ]),
    { code: "process-failed" },
  );
});

interface FakeCliState {
  readonly listOutput?: string;
  readonly listExitCode?: number;
  readonly listStderr?: string;
}

async function fakeEditorCli(t: TestContext, initial: FakeCliState) {
  const root = await mkdtemp(join(tmpdir(), "settings-sync-cli-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "out"), { recursive: true });
  const statePath = join(root, "state.json");
  const callsPath = join(root, "calls.json");
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(callsPath, "[]");
  await writeFile(
    join(root, "out", "cli.js"),
    `const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
const callsPath = path.join(root, "calls.json");
const calls = JSON.parse(fs.readFileSync(callsPath, "utf8"));
const args = process.argv.slice(2);
calls.push(args);
fs.writeFileSync(callsPath, JSON.stringify(calls));
if (args[0] === "--list-extensions") {
  if (state.listStderr) process.stderr.write(state.listStderr);
  if (state.listOutput) process.stdout.write(state.listOutput);
  process.exit(state.listExitCode ?? 0);
}
process.exit(0);
`,
  );
  const options: InventoryOptions = {
    executable: process.execPath,
    appRoot: root,
    source: {
      uri: "file:///settings.json",
      userDataDirectory: join(root, "user-data"),
      editorProfile: "Work",
      extensionsDirectory: join(root, "extensions"),
    },
  };
  return {
    options,
    async setState(next: FakeCliState) {
      await writeFile(statePath, JSON.stringify(next));
    },
    async calls(): Promise<string[][]> {
      return JSON.parse(await readFile(callsPath, "utf8")) as string[][];
    },
  };
}
