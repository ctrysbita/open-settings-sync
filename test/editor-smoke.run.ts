import assert from "node:assert/strict";
import { dirname, join, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { readConfiguration } from "../src/editor/configuration";
import { EditorHost } from "../src/editor/host";
import {
  builtinInventory,
  installedExtensions,
  installInProfile,
  machineSettingsFromDirectory,
} from "../src/editor/inventory";
import { Review } from "../src/editor/review";
import { parseSettings } from "../src/editor/settings-document";
import { activeSource, openUserSettings } from "../src/editor/source";
import { FileStore } from "../src/storage/files";
import type { SyncPlan } from "../src/sync/session";

/** Run only in an editor with a fresh temporary user-data and extension directory. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("ctrysbita.open-settings-sync");
  assert.ok(extension, "development extension is registered");
  await reviewPreview();
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const name of ["configure", "sync", "restore", "showLog"]) {
    assert.ok(commands.includes(`openSettingsSync.${name}`));
  }
  const expectedData = process.env.VSCODE_TEST_USER_DATA_DIRECTORY;
  const expectedExtensions = process.env.VSCODE_TEST_EXTENSIONS_DIRECTORY;
  const vsix = process.env.VSCODE_TEST_VSIX;
  const profile = process.env.VSCODE_TEST_EDITOR_PROFILE ?? "";
  assert.ok(expectedData, "smoke tests require a disposable user-data directory");
  assert.ok(expectedExtensions && vsix);
  const sandbox = dirname(expectedData);
  assert.equal(relative(resolve(__dirname, "..", "..", ".test-editor"), dirname(sandbox)), "");
  assert.match(relative(dirname(sandbox), sandbox), /^host-[\w-]+$/);
  assert.equal(resolve(expectedData), join(sandbox, "user-data"));
  assert.equal(resolve(expectedExtensions), join(sandbox, "extensions"));
  assert.equal(resolve(vsix), join(sandbox, "fixture.vsix"));
  const document = await openUserSettings();
  const pathInUserData = relative(expectedData, document.uri.fsPath).split(/[\\/]/).join("/");
  if (profile) assert.match(pathInUserData, /^User\/profiles\/[^/]+\/settings\.json$/);
  else assert.equal(pathInUserData, "User/settings.json");

  // Finish the host's boolean-to-string migration before observing settings edits.
  const extensionSettings = vscode.workspace.getConfiguration("extensions");
  const autoUpdate = extensionSettings.inspect<unknown>("autoUpdate");
  const disabled = typeof autoUpdate?.defaultValue === "string" ? "off" : false;
  if (autoUpdate?.globalValue !== disabled)
    await extensionSettings.update("autoUpdate", disabled, vscode.ConfigurationTarget.Global);

  const store = new FileStore(join(sandbox, "bindings"));
  const context = {
    extensionMode: vscode.ExtensionMode.Development,
    extensionUri: extension.extensionUri,
  };
  const binding = {
    uri: document.uri.toString(),
    userDataDirectory: expectedData,
    editorProfile: profile,
    extensionsDirectory: "",
  };
  await store.exclusive(async () =>
    store.saveSource({
      ...binding,
      uri: vscode.Uri.file(join(sandbox, "other", "settings.json")).toString(),
    }),
  );
  await assert.rejects(activeSource(context, store, "use"), { code: "invalid-configuration" });
  await store.exclusive(async () => store.saveSource(binding));
  const source = await activeSource(context, store, "use");
  assert.equal(relative(expectedData, source.userDataDirectory), "");
  assert.equal(source.editorProfile, profile);
  const builtin = await builtinInventory(vscode.env.appRoot);
  assert.ok(builtin.extensions.includes("vscode.git"), "built-in manifest inventory is available");
  const isolatedSource = {
    ...source,
    extensionsDirectory: expectedExtensions,
  };
  const host = new EditorHost(
    isolatedSource,
    new Set(builtin.extensions),
    new AbortController().signal,
  );
  const otherProfile = new EditorHost(
    { ...isolatedSource, uri: vscode.Uri.file(join(sandbox, "other", "settings.json")).toString() },
    new Set(),
    new AbortController().signal,
  );
  await assert.rejects(otherProfile.replace("{}", "{}"), { code: "local-changed" });
  const connection = await readConfiguration(source);
  assert.equal(connection.remote, join(sandbox, "default-remote.git"));
  assert.equal(connection.branch, "default-branch");
  assert.deepEqual(connection.ignoredSettings, ["syncSmoke.shared*"]);
  assert.deepEqual(connection.ignoredExtensions, ["shared.*"]);
  const before = await host.read();
  if (!profile) assert.deepEqual(before.snapshot.extensions, ["sync-smoke.fixture"]);
  assert.ok(!before.snapshot.extensions.includes("sync-smoke.installed-fixture"));
  assert.ok(
    (await machineSettingsFromDirectory(isolatedSource.extensionsDirectory)).includes(
      "syncSmoke.executable",
    ),
  );
  await host.applySettings(before.settingsText, [
    { key: "editor.fontSize", before: before.snapshot.settings["editor.fontSize"], after: 19 },
    ...(profile
      ? [
          {
            key: "openSettingsSync.git.remote",
            before: undefined,
            after: join(sandbox, "named-remote.git"),
          },
          {
            key: "openSettingsSync.ignoredSettings",
            before: undefined,
            after: ["syncSmoke.shared*", "syncSmoke.named*"],
          },
          {
            key: "openSettingsSync.ignoredExtensions",
            before: undefined,
            after: ["named.*"],
          },
        ]
      : []),
  ]);
  assert.equal((await host.read()).snapshot.settings["editor.fontSize"], 19);
  if (profile) {
    const named = await readConfiguration(source);
    assert.equal(named.remote, join(sandbox, "named-remote.git"));
    assert.equal(named.branch, "main");
    assert.deepEqual(named.ignoredSettings, ["syncSmoke.shared*", "syncSmoke.named*"]);
    assert.deepEqual(named.ignoredExtensions, ["shared.*", "named.*"]);
    const defaults = await vscode.workspace.openTextDocument(
      vscode.Uri.file(join(expectedData, "User", "settings.json")),
    );
    assert.equal(
      parseSettings(defaults.getText())["openSettingsSync.git.remote"],
      connection.remote,
    );
  }
  await assert.rejects(host.installExtension("vscode.git"), { code: "invalid-data" });
  await host.applySettings(await host.settingsText(), [
    { key: "syncSmoke.last", before: undefined, after: true },
    { key: "syncSmoke.first", before: undefined, after: true },
  ]);
  const order = ["syncSmoke.first", "syncSmoke.last"];
  await host.applySettings(await host.settingsText(), [], order);
  assert.deepEqual(
    Object.keys(parseSettings(await host.settingsText())).filter((key) => order.includes(key)),
    order,
  );
  const cli = { executable: process.execPath, appRoot: vscode.env.appRoot, source: isolatedSource };
  await installInProfile(cli, vsix);
  assert.deepEqual(
    (await host.read()).snapshot.extensions,
    [...before.snapshot.extensions, "sync-smoke.installed-fixture"].sort(),
  );
  if (profile) {
    const defaultInventory = await installedExtensions({
      ...cli,
      source: { ...isolatedSource, editorProfile: "" },
    });
    assert.ok(!defaultInventory.includes("sync-smoke.installed-fixture"));
    const key = "openSettingsSync.ignoredExtensions";
    await host.applySettings(await host.settingsText(), [{ key, before: ["named.*"], after: [] }]);
    assert.deepEqual((await readConfiguration(source)).ignoredExtensions, ["shared.*"]);
    await host.applySettings(await host.settingsText(), [{ key, before: [], after: null }]);
    await assert.rejects(readConfiguration(source), { code: "invalid-configuration" });
  }
  console.log("EDITOR_SMOKE_PASSED");
}

async function reviewPreview(): Promise<void> {
  const choices: boolean[] = [];
  const plan: SyncPlan = {
    settings: [],
    installExtensions: [],
    upload: true,
    recreateCollection: true,
    gitSettings: [],
    gitExtensions: [],
    excludedSettings: [],
    excludedExtensions: [],
  };
  const review = new Review(async (_message, options, ...actions) => {
    choices.push(options.modal === true);
    assert.ok(actions.includes("Recreate on Git"));
    assert.ok(!actions.includes("Sync"));
    if (options.modal) return "Preview";
    const document = vscode.window.activeTextEditor?.document;
    assert.equal(document?.uri.scheme, "open-settings-sync-preview");
    assert.equal(JSON.parse(document.getText()).recreateCollection, true);
    return "Cancel";
  });
  const registration = vscode.workspace.registerTextDocumentContentProvider(
    "open-settings-sync-preview",
    review,
  );
  try {
    assert.equal(await review.review(plan, "Default", new AbortController().signal), false);
    assert.deepEqual(choices, [true, false]);
  } finally {
    registration.dispose();
    review.dispose();
  }
}
