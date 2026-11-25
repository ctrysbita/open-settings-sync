import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConnection, resolveIgnoredPatterns } from "../src/editor/configuration-resolver";

test("named profiles inherit default connection only until they configure their own remote", () => {
  const defaults = {
    "openSettingsSync.git.remote": "git@github.com:user/default.git",
    "openSettingsSync.git.branch": "shared",
    "openSettingsSync.profile": "base",
  };
  assert.deepEqual(resolveConnection({}, defaults), {
    remote: "git@github.com:user/default.git",
    branch: "shared",
    profile: "base",
  });
  assert.deepEqual(resolveConnection({ "openSettingsSync.profile": "work" }, defaults), {
    remote: "git@github.com:user/default.git",
    branch: "shared",
    profile: "work",
  });
  assert.deepEqual(
    resolveConnection({ "openSettingsSync.git.remote": "git@github.com:user/work.git" }, defaults),
    {
      remote: "git@github.com:user/work.git",
      branch: "main",
      profile: "main",
    },
  );
});

test("ignored patterns merge defaults with local overrides and reject invalid types", () => {
  const key = "openSettingsSync.ignoredSettings";
  assert.deepEqual(
    resolveIgnoredPatterns(key, { [key]: ["a.*", "shared.*"] }, { [key]: ["shared.*", "b.*"] }),
    ["a.*", "shared.*", "b.*"],
  );
  assert.throws(() => resolveConnection({ "openSettingsSync.git.remote": 123 }, {}), {
    code: "invalid-configuration",
  });
  assert.throws(() => resolveIgnoredPatterns(key, {}, { [key]: ["ok", 42] }), {
    code: "invalid-configuration",
  });
  assert.throws(() => resolveIgnoredPatterns(key, { [key]: null }, {}), {
    code: "invalid-configuration",
  });
});
