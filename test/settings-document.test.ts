import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSettings, patchSettings } from "../src/editor/settings-document";

test("settings edits preserve comments trailing commas CRLF and ignored values", () => {
  const original =
    '{\r\n  // keep this comment\r\n  "editor.fontSize": 12,\r\n  "api.token": "local-only",\r\n}\r\n';
  const next = patchSettings(original, [{ key: "editor.fontSize", before: 12, after: 14 }]);
  assert.match(next, /keep this comment/);
  assert.match(next, /\r\n/);
  assert.deepEqual(parseSettings(next), { "editor.fontSize": 14, "api.token": "local-only" });
});

test("deleting a setting does not turn deletion into null or erase unrelated keys", () => {
  const next = patchSettings('{"font":12,"keep":true}', [
    { key: "font", before: 12, after: undefined },
  ]);
  assert.deepEqual(parseSettings(next), { keep: true });
});

test("removing the first setting preserves the next setting's comment and CRLF indentation", () => {
  const before = '{\r\n  "drop": true,\r\n  // explains keep\r\n  "keep": 1,\r\n}\r\n';
  assert.equal(
    patchSettings(before, [{ key: "drop", before: true, after: undefined }]),
    '{\r\n  // explains keep\r\n  "keep": 1,\r\n}\r\n',
  );
});

test("deleting middle, last and only properties keeps comments around separators", () => {
  for (const [text, expected] of [
    ['{"a":1, "drop":1 /*first*/ , /*second*/ "b":2}', { a: 1, b: 2 }],
    ['{"a":1 /*first*/, // second\n "drop":1}', { a: 1 }],
    ['{ /*first*/ "drop":1, // second\n}', {}],
    ['{ /*first*/ "drop":1 /*second*/ }', {}],
  ] as const) {
    const result = patchSettings(text, [{ key: "drop", before: 1, after: undefined }]);
    assert.deepEqual(parseSettings(result), expected);
    assert.match(result, /first/);
    assert.match(result, /second/);
  }
});

test("empty JSONC can receive its first setting and unknown setting names survive", () => {
  assert.deepEqual(
    parseSettings(
      patchSettings("// local settings\n", [
        { key: "vendor.future", before: undefined, after: { a: [1, null] } },
      ]),
    ),
    {
      "vendor.future": { a: [1, null] },
    },
  );
});

test("malformed JSONC duplicate keys and non-object roots are rejected before writing", () => {
  for (const text of ['{"x":', '{"x":1,"x":2}', '{"nested":{"x":1,"x":2}}', "[]", "null"]) {
    assert.throws(() => parseSettings(text));
  }
});

test("prototype-shaped property names cannot modify object prototypes", () => {
  const next = patchSettings("{}", [
    { key: "__proto__", before: undefined, after: { harmless: true } },
  ]);
  const value = parseSettings(next);
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.equal(Object.hasOwn({}, "harmless"), false);
});

test("reordering nested theme rules retains JSONC comments, CRLF and the literal spelling", () => {
  const key = "workbench.colorCustomizations";
  const original = [
    "{",
    '  "workbench.colorCustomizations": {',
    "    // exact theme",
    '    "[Default Dark Modern]": { "editor.background": "#111111" }, // exact',
    "    // fallback",
    '    "[*Dark*]": { "editor.background": "#222222" }',
    "  },",
    '  "other": 1e2,',
    "}",
    "",
  ].join("\r\n");
  const before = parseSettings(original)[key];
  const after = {
    "[*Dark*]": { "editor.background": "#222222" },
    "[Default Dark Modern]": { "editor.background": "#111111" },
  };
  const text = patchSettings(original, [{ key, before, after }]);
  assert.equal(
    text,
    [
      "{",
      '  "workbench.colorCustomizations": {',
      "    // fallback",
      '    "[*Dark*]": { "editor.background": "#222222" },',
      "    // exact theme",
      '    "[Default Dark Modern]": { "editor.background": "#111111" } // exact',
      "  },",
      '  "other": 1e2,',
      "}",
      "",
    ].join("\r\n"),
  );
});

test("objects inside arrays and numeric property names retain written order in both directions", () => {
  const original = '{"20":[{"2":true, "1":false}],"3":null}';
  const wanted = parseSettings('{"3":null,"20":[{"1":false,"2":true}]}');
  const before = parseSettings(original);
  assert.deepEqual(Object.keys(before), ["20", "3"]);
  const next = patchSettings(
    original,
    [{ key: "20", before: before["20"], after: wanted["20"] }],
    Object.keys(wanted),
  );
  assert.equal(next, '{"3":null,"20":[{"1":false, "2":true}]}');
});

test("top-level indentation detection ignores deeper nested properties on earlier lines", () => {
  const original = '{"nested": {\n      "inner": 1\n    },\n  "top": 2\n}\n';
  const next = patchSettings(original, [{ key: "added", before: undefined, after: true }]);
  assert.ok(next.includes('\n  "added": true\n'));
});
