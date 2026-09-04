import type { EditOperation } from "./repository_model.js";

export type TextFile = {
  readonly kind: "text";
  readonly bytes: Uint8Array;
  readonly tokens: readonly string[];
  readonly hasFinalNewline: boolean;
};

export type BinaryFile = {
  readonly kind: "binary";
  readonly bytes: Uint8Array;
};

export type ClassifiedFile = TextFile | BinaryFile;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  const text = Buffer.from(bytes).toString("utf8");
  return equalBytes(Buffer.from(text, "utf8"), bytes) ? text : undefined;
}

/** Split UTF-8 text after each LF byte, retaining the LF in its token. */
export function tokenizeText(bytes: Uint8Array): readonly string[] {
  const text = decodeText(bytes);
  if (text === undefined) throw new TypeError("bytes are not valid text");
  if (text.length === 0) return [];

  const tokens: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      tokens.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) tokens.push(text.slice(start));
  return tokens;
}

/** Classify bytes without normalizing their contents. Empty files are text. */
export function classifyFile(bytes: Uint8Array): ClassifiedFile {
  const copy = new Uint8Array(bytes);
  const text = decodeText(copy);
  if (text === undefined) return { kind: "binary", bytes: copy };
  const tokens = tokenizeText(copy);
  return {
    kind: "text",
    bytes: copy,
    tokens,
    hasFinalNewline: copy.length > 0 && copy[copy.length - 1] === 10,
  };
}

function appendOperation(operations: EditOperation[], operation: EditOperation): void {
  const previous = operations[operations.length - 1];
  if (previous !== undefined) {
    if ("retain" in previous && "retain" in operation) {
      operations[operations.length - 1] = { retain: previous.retain + operation.retain };
      return;
    }
    if ("delete" in previous && "delete" in operation) {
      operations[operations.length - 1] = { delete: previous.delete + operation.delete };
      return;
    }
    if ("insert" in previous && "insert" in operation) {
      operations[operations.length - 1] = {
        insert: [...previous.insert, ...operation.insert],
      };
      return;
    }
  }
  operations.push(operation);
}

/**
 * Generate the canonical token edit from old bytes to new bytes.
 * The dynamic-programming recurrence intentionally chooses deletion on ties.
 */
export function canonicalTextDiff(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): readonly EditOperation[] {
  const oldTokens = tokenizeText(oldBytes);
  const newTokens = tokenizeText(newBytes);
  const rows = oldTokens.length + 1;
  const columns = newTokens.length + 1;
  const distances = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));

  for (let oldIndex = oldTokens.length; oldIndex >= 0; oldIndex -= 1) {
    const row = distances[oldIndex];
    if (row === undefined) continue;
    for (let newIndex = newTokens.length; newIndex >= 0; newIndex -= 1) {
      if (oldIndex === oldTokens.length) {
        row[newIndex] = newTokens.length - newIndex;
      } else if (newIndex === newTokens.length) {
        row[newIndex] = oldTokens.length - oldIndex;
      } else if (oldTokens[oldIndex] === newTokens[newIndex]) {
        row[newIndex] = distances[oldIndex + 1]?.[newIndex + 1] ?? 0;
      } else {
        const deleteCost = distances[oldIndex + 1]?.[newIndex] ?? 0;
        const insertCost = row[newIndex + 1] ?? 0;
        row[newIndex] = 1 + Math.min(deleteCost, insertCost);
      }
    }
  }

  const operations: EditOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
    const oldToken = oldTokens[oldIndex];
    const newToken = newTokens[newIndex];
    if (oldToken !== undefined && newToken !== undefined && oldToken === newToken) {
      appendOperation(operations, { retain: 1 });
      oldIndex += 1;
      newIndex += 1;
    } else if (oldIndex === oldTokens.length) {
      if (newToken === undefined) throw new Error("diff cursor invariant violated");
      appendOperation(operations, { insert: [newToken] });
      newIndex += 1;
    } else if (newIndex === newTokens.length) {
      appendOperation(operations, { delete: 1 });
      oldIndex += 1;
    } else {
      const deleteCost = distances[oldIndex + 1]?.[newIndex] ?? 0;
      const insertCost = distances[oldIndex]?.[newIndex + 1] ?? 0;
      if (deleteCost <= insertCost) {
        appendOperation(operations, { delete: 1 });
        oldIndex += 1;
      } else {
        if (newToken === undefined) throw new Error("diff cursor invariant violated");
        appendOperation(operations, { insert: [newToken] });
        newIndex += 1;
      }
    }
  }
  return operations;
}

function renderToken(prefix: " " | "+" | "-", token: string): string {
  const rendered = `${prefix}${token}`;
  return token.endsWith("\n") ? rendered : `${rendered}\n\\ No newline at end of file\n`;
}

/** Render one whole-file unified diff block, or a binary marker. */
export function renderFileDiff(
  path: string,
  oldBytes: Uint8Array | undefined,
  newBytes: Uint8Array | undefined,
): string {
  if (oldBytes === undefined && newBytes === undefined) return "";
  if (oldBytes !== undefined && newBytes !== undefined && equalBytes(oldBytes, newBytes)) return "";
  const oldFile = oldBytes === undefined ? undefined : classifyFile(oldBytes);
  const newFile = newBytes === undefined ? undefined : classifyFile(newBytes);
  const oldLabel = oldBytes === undefined ? "/dev/null" : `a/${path}`;
  const newLabel = newBytes === undefined ? "/dev/null" : `b/${path}`;
  if (oldFile?.kind === "binary" || newFile?.kind === "binary") {
    return `Binary files ${oldLabel} and ${newLabel} differ\n`;
  }

  const oldTokens = oldFile?.tokens ?? [];
  const newTokens = newFile?.tokens ?? [];
  const edit = canonicalTextDiff(oldBytes ?? new Uint8Array(), newBytes ?? new Uint8Array());
  let output = `--- ${oldLabel}\n+++ ${newLabel}\n@@ -1,${oldTokens.length} +1,${newTokens.length} @@\n`;
  let oldIndex = 0;
  for (const operation of edit) {
    if ("retain" in operation) {
      for (let count = 0; count < operation.retain; count += 1) {
        const token = oldTokens[oldIndex++];
        if (token === undefined) throw new Error("diff render invariant violated");
        output += renderToken(" ", token);
      }
    } else if ("delete" in operation) {
      for (let count = 0; count < operation.delete; count += 1) {
        const token = oldTokens[oldIndex++];
        if (token === undefined) throw new Error("diff render invariant violated");
        output += renderToken("-", token);
      }
    } else {
      for (const token of operation.insert) output += renderToken("+", token);
    }
  }
  return output;
}
