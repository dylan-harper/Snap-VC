import { parseJsonUnique } from "./json.js";
import { isPathPrefix, validateTrackedPath } from "./working_tree.js";
import { validateRepositoryHistory } from "./replay.js";
import {
  validateContributorId,
  validateRevision,
  versionFromPairs,
  type Revision,
} from "./versions.js";

export type Version = ReadonlyMap<string, Revision>;
export type EditOperation =
  | { readonly retain: Revision }
  | { readonly delete: Revision }
  | { readonly insert: readonly string[] };
export type TextChange = {
  readonly type: "text";
  readonly path: string;
  readonly edit: readonly EditOperation[];
};
export type PutChange = {
  readonly type: "put";
  readonly path: string;
  readonly content: Uint8Array;
};
export type DeleteChange = { readonly type: "delete"; readonly path: string };
export type Change = TextChange | PutChange | DeleteChange;
export interface Patch {
  readonly author: string;
  readonly revision: Revision;
  readonly base: Version;
  readonly message: string;
  readonly changes: readonly Change[];
}
export interface RepositoryModel {
  readonly format: 1;
  readonly frontier: Version;
  readonly patches: readonly Patch[];
}
export type Tree = ReadonlyMap<string, Uint8Array>;

export class RepositoryModelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryModelError";
  }
}

function fail(message: string): never {
  throw new RepositoryModelError(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function unknownField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !keys.includes(key));
}

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function parseVersionValue(value: unknown): Version {
  if (!Array.isArray(value)) fail("version must be an array");
  const pairs: Array<readonly [string, Revision]> = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) fail("invalid version pair");
    const id = pair[0];
    const revision = pair[1];
    try {
      pairs.push([validateContributorId(id), validateRevision(revision)]);
    } catch (error) {
      fail(error instanceof Error ? error.message : "invalid version");
    }
  }
  try {
    return versionFromPairs(pairs);
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid version");
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseMessage(value: unknown): string {
  if (value === "") fail("patch message is empty");
  if (typeof value !== "string") fail("patch message is invalid");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail("message contains control character");
  }
  return value;
}

function parseBase64(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    fail("content is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("content is not canonical base64");
  return new Uint8Array(bytes);
}

function parseTextToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    fail("text insert token is invalid");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.includes(0)) fail("text insert token is invalid");
  if (bytes.subarray(0, -1).includes(10)) fail("text insert token is not canonical");
  return value;
}

function parseEdit(value: unknown): readonly EditOperation[] {
  if (!Array.isArray(value)) fail("edit must be an array");
  const result: EditOperation[] = [];
  let previous: string | undefined;
  for (const operation of value) {
    if (!record(operation) || Object.keys(operation).length !== 1)
      fail("edit operation must have one operation");
    const kind = Object.keys(operation)[0];
    const operand = operation[kind ?? ""];
    if (kind === "retain" || kind === "delete") {
      if (!isPositiveSafeInteger(operand)) fail("edit count must be a positive safe integer");
      if (previous === kind) fail(`adjacent ${kind} operations are forbidden`);
      previous = kind;
      result.push(kind === "retain" ? { retain: operand } : { delete: operand });
    } else if (kind === "insert") {
      if (!Array.isArray(operand)) fail("insert is invalid");
      if (operand.length === 0) fail("text insert is empty");
      if (previous === kind) fail("adjacent insert operations are forbidden");
      const tokens = operand.map(parseTextToken);
      for (let index = 0; index < tokens.length - 1; index += 1) {
        if (!tokens[index]?.endsWith("\n")) fail("insert token is not canonical");
      }
      previous = kind;
      result.push({ insert: tokens });
    } else {
      fail("unknown edit operation");
    }
  }
  return result;
}

function parseChange(value: unknown): Change {
  if (!record(value) || typeof value.type !== "string") fail("invalid change");
  if (value.type === "delete") {
    const extra = unknownField(value, ["type", "path"]);
    if (extra !== undefined) fail(`change has unknown field: ${extra}`);
    if (!exact(value, ["type", "path"]) || typeof value.path !== "string")
      fail("invalid delete change");
    return { type: "delete", path: validatePath(value.path) };
  }
  if (value.type === "put") {
    const extra = unknownField(value, ["type", "path", "content"]);
    if (extra !== undefined) fail(`change has unknown field: ${extra}`);
    if (!exact(value, ["type", "path", "content"]) || typeof value.path !== "string")
      fail("invalid put change");
    return { type: "put", path: validatePath(value.path), content: parseBase64(value.content) };
  }
  if (value.type === "text") {
    const extra = unknownField(value, ["type", "path", "edit"]);
    if (extra !== undefined) fail(`change has unknown field: ${extra}`);
    if (!exact(value, ["type", "path", "edit"]) || typeof value.path !== "string")
      fail("invalid text change");
    return { type: "text", path: validatePath(value.path), edit: parseEdit(value.edit) };
  }
  fail("unknown change type");
}

function validatePath(path: string): string {
  try {
    return validateTrackedPath(path);
  } catch {
    fail(`path is invalid: ${path}`);
  }
}

function parsePatch(value: unknown): Patch {
  if (!record(value) || !exact(value, ["author", "revision", "base", "message", "changes"]))
    fail("invalid patch schema");
  let author: string;
  let revision: Revision;
  try {
    author = validateContributorId(value.author);
    revision = validateRevision(value.revision);
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid patch identity");
  }
  const base = parseVersionValue(value.base);
  const message = parseMessage(value.message);
  if (!Array.isArray(value.changes)) fail("patch changes is invalid");
  if (value.changes.length === 0) fail("patch changes is empty");
  const changes = value.changes.map(parseChange);
  for (let index = 1; index < changes.length; index += 1) {
    const previous = changes[index - 1];
    const current = changes[index];
    if (
      previous === undefined ||
      current === undefined ||
      utf8Compare(previous.path, current.path) >= 0
    ) {
      fail("changes are not in canonical path order");
    }
  }
  for (let leftIndex = 0; leftIndex < changes.length; leftIndex += 1) {
    const left = changes[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < changes.length; rightIndex += 1) {
      const right = changes[rightIndex];
      if (right === undefined) continue;
      if (!isPathPrefix(left.path, right.path)) continue;
      const isTransition = left.type === "delete" || right.type === "delete";
      if (!isTransition) fail(`tree paths conflict: ${left.path} and ${right.path}`);
    }
  }
  return { author, revision, base, message, changes };
}

/** Parse strict repository JSON and validate its complete causal history. */
export function parseRepository(text: unknown): RepositoryModel {
  const value = parseJsonUnique(text);
  if (!record(value)) fail("invalid repository schema");
  const extra = unknownField(value, ["format", "frontier", "patches"]);
  if (extra !== undefined) fail(`repository has unknown field: ${extra}`);
  if (!exact(value, ["format", "frontier", "patches"]) || value.format !== 1)
    fail("invalid repository schema");
  const frontier = parseVersionValue(value.frontier);
  if (!Array.isArray(value.patches)) fail("patches must be an array");
  const patches = value.patches.map(parsePatch);
  const byDot = new Map<string, Patch>();
  for (const patch of patches) {
    const key = `${patch.author}\u0000${patch.revision}`;
    if (byDot.has(key)) fail(`duplicate patch dot: ${patch.author}->${patch.revision}`);
    byDot.set(key, patch);
  }
  for (let index = 1; index < patches.length; index += 1) {
    const previous = patches[index - 1];
    const current = patches[index];
    if (
      previous === undefined ||
      current === undefined ||
      utf8Compare(previous.author, current.author) > 0 ||
      (previous.author === current.author && previous.revision >= current.revision)
    ) {
      fail("patches are not in canonical order");
    }
  }
  for (const [id, revision] of frontier) {
    for (let number = 1; number <= revision; number += 1) {
      if (!byDot.has(`${id}\u0000${number}`)) fail(`missing ${id}->${number}`);
    }
  }
  for (const patch of patches) {
    if (patch.revision > (frontier.get(patch.author) ?? 0)) {
      fail(`unreachable patch: ${patch.author}->${patch.revision}`);
    }
  }
  for (const patch of patches) {
    for (const [id, revision] of patch.base) {
      if (revision > (frontier.get(id) ?? 0)) fail(`base is outside frontier: ${id}`);
      for (let number = 1; number <= revision; number += 1) {
        if (!byDot.has(`${id}\u0000${number}`)) fail(`missing ${id}->${number}`);
      }
    }
    if (patch.revision !== (patch.base.get(patch.author) ?? 0) + 1)
      fail("patch revision does not follow base");
  }
  const pending = new Set(patches);
  while (pending.size > 0) {
    const ready = [...pending].filter((patch) =>
      [...patch.base].every(([id, revision]) => {
        for (let number = 1; number <= revision; number += 1) {
          const dependency = byDot.get(`${id}\u0000${number}`);
          if (dependency !== undefined && pending.has(dependency)) return false;
        }
        return true;
      }),
    );
    if (ready.length === 0) fail("cyclic or incomplete patch history");
    pending.delete(ready[0] as Patch);
  }
  const model = { format: 1 as const, frontier, patches };
  try {
    validateRepositoryHistory(model);
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid repository history");
  }
  return model;
}

function repositoryJsonValue(model: RepositoryModel): Record<string, unknown> {
  return {
    format: model.format,
    frontier: [...model.frontier].map(([id, revision]) => [id, revision]),
    patches: model.patches.map((patch) => ({
      author: patch.author,
      revision: patch.revision,
      base: [...patch.base].map(([id, revision]) => [id, revision]),
      message: patch.message,
      changes: patch.changes.map((change) =>
        change.type === "put"
          ? {
              type: change.type,
              path: change.path,
              content: Buffer.from(change.content).toString("base64"),
            }
          : change,
      ),
    })),
  };
}

/** Validate a typed model supplied by trusted code using the same rules. */
export function validateRepositoryModel(model: RepositoryModel): RepositoryModel {
  return parseRepository(JSON.stringify(repositoryJsonValue(model)));
}
