/** Moves JSONC source text so that a key-order edit retains comments and spelling. */
import { createScanner, findNodeAtLocation, type Node, parseTree, SyntaxKind } from "jsonc-parser";
import { SyncFailure } from "../sync/failure";
import { type Json, isRecord } from "../sync/snapshot";

/** Reorders participating properties in their existing slots. Other settings keep their slots. */
export function reorderTopLevelSettings(text: string, order: readonly string[]): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (root?.type !== "object")
    throw new SyncFailure("invalid-data", "Expected a settings object to reorder.");
  return replaceNode(text, root, renderObject(text, root, order));
}

/** Returns a source-preserving edit when all values match and only object order differs. */
export function reorderSettingValue(text: string, key: string, target: Json): string | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const node = root && findNodeAtLocation(root, [key]);
  if (!node) return undefined;
  const value = renderSameValue(text, node, target);
  return value === undefined ? undefined : replaceNode(text, node, value);
}

function replaceNode(text: string, node: Node, replacement: string): string {
  return text.slice(0, node.offset) + replacement + text.slice(node.offset + node.length);
}

function renderSameValue(text: string, node: Node, target: Json): string | undefined {
  const children = node.children ?? [];
  if (node.type === "object" && isRecord(target)) {
    const keys = Object.keys(target);
    if (keys.length !== children.length) return undefined;
    const values = new Map<string, string>();
    for (const property of children) {
      const [name, value] = property.children ?? [];
      if (!value || typeof name?.value !== "string") return undefined;
      const key: string = name.value;
      const child = Object.hasOwn(target, key) ? target[key] : undefined;
      if (child === undefined) return undefined;
      const rendered = renderSameValue(text, value, child);
      if (rendered === undefined) return undefined;
      values.set(key, rendered);
    }
    return renderObject(text, node, keys, values);
  }
  if (node.type === "array" && Array.isArray(target)) {
    if (children.length !== target.length) return undefined;
    let offset = node.offset;
    const parts: string[] = [];
    for (const [index, child] of children.entries()) {
      const value = target[index];
      if (value === undefined) return undefined;
      const rendered = renderSameValue(text, child, value);
      if (rendered === undefined) return undefined;
      parts.push(text.slice(offset, child.offset), rendered);
      offset = child.offset + child.length;
    }
    return parts.join("") + text.slice(offset, node.offset + node.length);
  }
  return target === node.value ? text.slice(node.offset, node.offset + node.length) : undefined;
}

function renderObject(
  text: string,
  node: Node,
  order: readonly string[],
  values?: ReadonlyMap<string, string>,
): string {
  const properties = node.children ?? [];
  const tokens = createScanner(text, true);
  const trivia = createScanner(text);
  let offset = node.offset + 1;
  const slots = properties.map((property, index) => {
    const [name, value] = property.children ?? [];
    if (!value || typeof name?.value !== "string")
      throw new SyncFailure("invalid-data", "Invalid settings property.");
    const key: string = name.value;
    const end = property.offset + property.length;
    tokens.setPosition(end);
    const comma = tokens.scan() === SyntaxKind.CommaToken;
    const delimiter = comma ? tokens.getTokenOffset() : end;
    const after = comma ? tokens.getPosition() : end;
    const limit = properties[index + 1]?.offset ?? node.offset + node.length - 1;
    // Standalone comments introduce the next key. A comment on the comma's line trails this key.
    trivia.setPosition(after);
    let boundary = after;
    let lineComment = false;
    while (trivia.getPosition() < limit) {
      const token = trivia.scan();
      if (token === SyntaxKind.Trivia) continue;
      if (token !== SyntaxKind.LineCommentTrivia && token !== SyntaxKind.BlockCommentTrivia) break;
      boundary = trivia.getPosition();
      lineComment = token === SyntaxKind.LineCommentTrivia;
    }
    const space = /^\s*/.exec(text.slice(offset, property.offset))?.[0] ?? "";
    const body =
      text.slice(offset + space.length, value.offset) +
      (values?.get(key) ?? text.slice(value.offset, end)) +
      text.slice(end, delimiter);
    offset = boundary;
    return { key, space, body, comma, tail: text.slice(after, boundary), lineComment };
  });
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  const selected = new Set(order);
  const remaining = order.values();
  const parts = ["{"];
  const suffix = text.slice(offset, node.offset + node.length);
  for (const [index, slot] of slots.entries()) {
    const next = selected.has(slot.key) ? remaining.next().value : slot.key;
    const item = next === undefined ? undefined : byKey.get(next);
    if (!item) throw new SyncFailure("invalid-data", "Setting order does not match the document.");
    parts.push(slot.space, item.body, slot.comma ? "," : "", item.tail);
    const following = slots[index + 1]?.space ?? suffix;
    if (item.lineComment && !/^[ \t]*[\r\n]/.test(following))
      parts.push(text.includes("\r\n") ? "\r\n" : "\n");
  }
  if (!remaining.next().done)
    throw new SyncFailure("invalid-data", "Setting order contains an absent or duplicate key.");
  return parts.join("") + suffix;
}
