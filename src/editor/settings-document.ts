/** JSONC editing preserves comments and all excluded settings in the local document. */
import { applyEdits, createScanner, type Edit, modify, parseTree, SyntaxKind } from "jsonc-parser";
import { SyncFailure } from "../sync/failure";
import { parseJsonText } from "../sync/json";
import type { SettingChange } from "../sync/merge";
import { decodeSettings, type Settings } from "../sync/snapshot";
import { reorderSettingValue, reorderTopLevelSettings } from "./settings-order";

/** Rejects syntax errors and duplicate keys instead of silently choosing a value. */
export function parseSettings(text: string): Settings {
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    throw new SyncFailure("invalid-data", "The settings file exceeds 2 MiB.");
  }
  return decodeSettings(parseJsonText(text, { allowTrailingComma: true, allowEmptyContent: true }));
}

/** Only the selected keys are edited; JSONC comments and local-only values survive. */
export function patchSettings(
  text: string,
  changes: readonly SettingChange[],
  order?: readonly string[],
): string {
  parseSettings(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentation = detectTopLevelIndentation(text);
  let result = text;
  for (const change of changes) {
    if (change.after === undefined) {
      result = removeSetting(result, change.key);
      continue;
    }
    if (change.before !== undefined && change.after !== null && typeof change.after === "object") {
      const reordered = reorderSettingValue(result, change.key, change.after);
      if (reordered !== undefined) {
        result = reordered;
        continue;
      }
    }
    result = applyEdits(
      result,
      modify(result, [change.key], change.after, {
        formattingOptions: {
          insertSpaces: !indentation.includes("\t"),
          tabSize: indentation.length,
          eol,
        },
      }),
    );
  }
  if (order) result = reorderTopLevelSettings(result, order);
  parseSettings(result);
  return result;
}

function detectTopLevelIndentation(text: string): string {
  const properties = parseTree(text, [], { allowTrailingComma: true })?.children ?? [];
  for (const property of properties) {
    const lineStart =
      Math.max(
        text.lastIndexOf("\n", property.offset - 1),
        text.lastIndexOf("\r", property.offset - 1),
      ) + 1;
    const prefix = text.slice(lineStart, property.offset);
    if (/^[\t ]+$/.test(prefix)) return prefix;
  }
  return "  ";
}

function removeSetting(text: string, key: string): string {
  const properties = parseTree(text, [], { allowTrailingComma: true })?.children ?? [];
  const index = properties.findIndex((property) => property.children?.[0]?.value === key);
  const property = properties[index];
  if (!property) return text;
  let start = property.offset;
  let end = start + property.length;
  const scanner = createScanner(text, true);
  scanner.setPosition(end);
  const edits: Edit[] = [];
  if (scanner.scan() === SyntaxKind.CommaToken) {
    const comma = scanner.getTokenOffset();
    if (/^[ \t]*$/.test(text.slice(end, comma))) end = comma + 1;
    else edits.push({ offset: comma, length: 1, content: "" });
  } else {
    const previous = properties[index - 1];
    if (previous) {
      scanner.setPosition(previous.offset + previous.length);
      if (scanner.scan() === SyntaxKind.CommaToken) {
        edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" });
      }
    }
  }
  // Remove an otherwise blank line while keeping adjacent comments and their indentation.
  const lineStart =
    Math.max(text.lastIndexOf("\n", start - 1), text.lastIndexOf("\r", start - 1)) + 1;
  const lineEnd = /^[ \t]*(?:\r\n|\n|\r)/.exec(text.slice(end));
  if (lineEnd && /^[ \t]*$/.test(text.slice(lineStart, start))) {
    start = lineStart;
    end += lineEnd[0].length;
  }
  edits.push({ offset: start, length: end - start, content: "" });
  return applyEdits(text, edits);
}
