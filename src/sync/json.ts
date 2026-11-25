import {
  type Node,
  type ParseError,
  type ParseOptions,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import { SyncFailure } from "./failure";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Builds a JSON object in source order, including keys JavaScript normally enumerates numerically.
 * Avoid plain object spreads (`{ ...obj }`) on returned values, as spreading strips the Proxy and
 * reorders array-index-like keys numerically.
 */
export function orderedObject(entries: readonly (readonly [string, Json])[]): Record<string, Json> {
  const object = Object.fromEntries(entries);
  const keys = Object.keys(object);
  if (keys.length !== entries.length)
    throw new SyncFailure("invalid-data", "Duplicate JSON property.");
  if (entries.every(([key], index) => key === keys[index])) return object;
  const order = entries.map(([key]) => key);
  return new Proxy(Object.freeze(object), { ownKeys: () => order });
}

/** Reads JSON in written order. JSONC and empty documents are enabled only for local settings. */
export function parseJsonText(
  text: string,
  options: ParseOptions = { disallowComments: true },
): Json {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, options);
  const first = errors[0];
  if (first)
    throw new SyncFailure(
      "invalid-data",
      `Invalid JSON: ${printParseErrorCode(first.error)} at offset ${first.offset}.`,
    );
  return root ? readValue(root, 0) : {};
}

function readValue(node: Node, depth: number): Json {
  // A snapshot wraps its settings object in one extra level.
  if (depth > 51) throw new SyncFailure("invalid-data", "JSON nesting exceeds the snapshot limit.");
  const children = node.children ?? [];
  if (node.type === "array") return children.map((child) => readValue(child, depth + 1));
  if (node.type === "object") {
    return orderedObject(
      children.map((property) => {
        const [name, value] = property.children ?? [];
        if (!value || typeof name?.value !== "string")
          throw new SyncFailure("invalid-data", "Invalid JSON property.");
        return [name.value, readValue(value, depth + 1)];
      }),
    );
  }
  return node.value;
}
