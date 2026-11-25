/** Run an editor extension test host using a disposable user profile. */
const { spawn, spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync, createWriteStream } = require("node:fs");
const { join, resolve } = require("node:path");

const executable = process.env.VSCODE_SYNC_EDITOR || process.argv[2];
if (!executable) {
  console.error(
    "Usage: set VSCODE_SYNC_EDITOR or run node scripts/smoke-editor.cjs <editor executable>",
  );
  process.exitCode = 2;
} else {
  const root = resolve(__dirname, "..");
  const parent = join(root, ".test-editor");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "host-"));
  const userSettings = join(directory, "user-data", "User");
  mkdirSync(userSettings, { recursive: true });
  writeFileSync(
    join(userSettings, "settings.json"),
    JSON.stringify({
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "telemetry.telemetryLevel": "off",
      "workbench.enableExperiments": false,
      "openSettingsSync.git.remote": join(directory, "default-remote.git"),
      "openSettingsSync.git.branch": "default-branch",
      "openSettingsSync.ignoredSettings": ["syncSmoke.shared*"],
      "openSettingsSync.ignoredExtensions": ["shared.*"],
    }),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const profile = process.argv[3] ?? "";
  env.VSCODE_TEST_EDITOR_PROFILE = profile;
  env.VSCODE_TEST_USER_DATA_DIRECTORY = join(directory, "user-data");
  env.VSCODE_TEST_EXTENSIONS_DIRECTORY = join(directory, "extensions");
  const fixture = join(directory, "extensions", "sync-smoke.fixture-1.0.0");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "fixture",
      publisher: "sync-smoke",
      version: "1.0.0",
      engines: { vscode: "^1.95.0" },
      contributes: {
        configuration: {
          properties: {
            "syncSmoke.executable": { type: "string", scope: "machine" },
          },
        },
      },
    }),
  );
  const packageFolder = join(directory, "fixture-package");
  mkdirSync(packageFolder, { recursive: true });
  writeFileSync(
    join(packageFolder, "package.json"),
    JSON.stringify({
      name: "installed-fixture",
      displayName: "Isolated Test Fixture",
      publisher: "sync-smoke",
      version: "1.0.0",
      license: "UNLICENSED",
      engines: { vscode: "^1.95.0" },
      contributes: {
        configuration: {
          properties: {
            "syncSmoke.installed": { type: "boolean", default: false },
          },
        },
      },
    }),
  );
  writeFileSync(join(packageFolder, "README.md"), "Isolated local installation test.\n");
  const vsix = join(directory, "fixture.vsix");
  const packaging = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "@vscode", "vsce", "vsce"),
      "package",
      "--allow-missing-repository",
      "--no-dependencies",
      "--out",
      vsix,
    ],
    { cwd: packageFolder, encoding: "utf8", windowsHide: true, timeout: 60000 },
  );
  if (packaging.status !== 0)
    throw new Error(`Could not package test fixture: ${packaging.stderr}`);
  env.VSCODE_TEST_VSIX = vsix;
  const log = createWriteStream(join(directory, "smoke.log"));
  const child = spawn(
    executable,
    [
      "--user-data-dir",
      join(directory, "user-data"),
      "--extensions-dir",
      join(directory, "extensions"),
      ...(profile ? ["--profile", profile] : []),
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${join(root, "build", "test", "editor-smoke.run.js")}`,
      "--disable-updates",
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
    ],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let passed = false;
  const timer = setTimeout(() => {
    console.error(`Editor smoke test timed out. Logs: ${directory}`);
    child.kill();
    process.exitCode = 1;
  }, 120000);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("EDITOR_SMOKE_PASSED")) passed = true;
      log.write(text);
      if (text.includes("EDITOR_SMOKE_PASSED")) console.log("EDITOR_SMOKE_PASSED");
    });
  }
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    log.end();
    if (code !== 0 || !passed) {
      console.error(`Editor smoke test failed. Logs: ${directory}`);
      process.exitCode = 1;
      return;
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Leave cleanup best-effort on Windows if editor child handles are still closing.
    }
  });
}
