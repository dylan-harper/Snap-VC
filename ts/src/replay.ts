import { canonicalTextDiff, classifyFile } from "./text_diff.js";
import type {
  Change,
  Patch,
  RepositoryModel,
  Tree,
  Version,
  EditOperation,
} from "./repository_model.js";
import { transformTextEdit } from "./ot.js";
import { formatVersion, snapCompare } from "./versions.js";
import { validatePrefixFree } from "./working_tree.js";

export interface ReplayResult {
  readonly tree: Tree;
  readonly warnings: readonly string[];
}

export class ReplayError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function applyText(base: Uint8Array | undefined, edit: readonly EditOperation[]): Uint8Array {
  const oldFile = base === undefined ? undefined : classifyFile(base);
  if (oldFile?.kind === "binary") throw new ReplayError("text change applied to binary content");
  const oldTokens = oldFile?.tokens ?? [];
  const output: string[] = [];
  let cursor = 0;
  for (const operation of edit) {
    if ("retain" in operation) {
      if (cursor + operation.retain > oldTokens.length) {
        throw new ReplayError("edit does not consume old content");
      }
      output.push(...oldTokens.slice(cursor, cursor + operation.retain));
      cursor += operation.retain;
    } else if ("delete" in operation) {
      if (cursor + operation.delete > oldTokens.length) {
        throw new ReplayError("edit consumes beyond old content");
      }
      cursor += operation.delete;
    } else {
      output.push(...operation.insert);
    }
  }
  if (cursor !== oldTokens.length) throw new ReplayError("edit does not consume old content");
  return new Uint8Array(Buffer.from(output.join(""), "utf8"));
}

function applyChange(tree: Map<string, Uint8Array>, change: Change): void {
  const old = tree.get(change.path);
  if (change.type === "delete") {
    if (old === undefined) throw new ReplayError(`delete of absent path: ${change.path}`);
    tree.delete(change.path);
  } else if (change.type === "put") {
    if (old !== undefined && equalBytes(old, change.content)) {
      throw new ReplayError(`no-op change: ${change.path}`);
    }
    tree.set(change.path, new Uint8Array(change.content));
  } else {
    const next = applyText(old, change.edit);
    if (old !== undefined && equalBytes(old, next)) {
      throw new ReplayError(`no-op change: ${change.path}`);
    }
    tree.set(change.path, next);
  }
}

function resultVersion(patch: Patch): Version {
  const result = new Map(patch.base);
  result.set(patch.author, patch.revision);
  return result;
}

function patchReady(patch: Patch, pending: ReadonlySet<Patch>): boolean {
  return [...patch.base].every(([id, revision]) => {
    for (let number = 1; number <= revision; number += 1) {
      const dependency = [...pending].find(
        (candidate) => candidate.author === id && candidate.revision === number,
      );
      if (dependency !== undefined) return false;
    }
    return true;
  });
}

function targetIsKnown(model: RepositoryModel, target: Version): boolean {
  const patches = new Map(
    model.patches.map((patch) => [`${patch.author}\u0000${patch.revision}`, patch]),
  );
  for (const [author, revision] of target) {
    for (let number = 1; number <= revision; number += 1) {
      if (!patches.has(`${author}\u0000${number}`)) return false;
    }
  }
  for (const patch of model.patches) {
    if (patch.revision > (target.get(patch.author) ?? 0)) continue;
    for (const [author, revision] of patch.base) {
      if ((target.get(author) ?? 0) < revision) return false;
    }
  }
  return true;
}

function applyExactPatch(base: Tree, patch: Patch): Tree {
  const result = new Map(base);
  for (const change of patch.changes) applyChange(result, change);
  validatePrefixFree(result.keys());
  return result;
}

function exactMaterialize(
  model: RepositoryModel,
  target: Version,
  exactTrees: Map<string, Tree>,
): Tree {
  const key = formatVersion(target);
  const cached = exactTrees.get(key);
  if (cached !== undefined) return cached;
  if (!targetIsKnown(model, target)) throw new ReplayError("unknown version");

  const selected = model.patches.filter(
    (patch) => patch.revision <= (target.get(patch.author) ?? 0),
  );
  const pending = new Set(selected);
  let current: Tree = new Map();
  while (pending.size > 0) {
    const ready = [...pending].filter((patch) => patchReady(patch, pending));
    ready.sort(
      (left, right) =>
        snapCompare(resultVersion(left), resultVersion(right)) ||
        Buffer.from(left.author).compare(Buffer.from(right.author)) ||
        left.revision - right.revision,
    );
    const patch = ready[0];
    if (patch === undefined) throw new ReplayError("cyclic or incomplete patch history");
    const base =
      exactTrees.get(formatVersion(patch.base)) ?? exactMaterialize(model, patch.base, exactTrees);
    const exactResult = applyExactPatch(base, patch);
    exactTrees.set(formatVersion(resultVersion(patch)), exactResult);
    current = integratePatch(current, base, patch).tree;
    pending.delete(patch);
  }
  const materialized = new Map(
    [...current.entries()].sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right))),
  );
  exactTrees.set(key, materialized);
  return materialized;
}

function sameTreeValue(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && equalBytes(left, right);
}

function integratePatch(
  current: Tree,
  base: Tree,
  patch: Patch,
): { readonly tree: Tree; readonly warnings: readonly string[] } {
  const authored = new Map(base);
  for (const change of patch.changes) applyChange(authored, change);
  validatePrefixFree(authored.keys());
  const result = new Map(current);
  const warnings = new Set<string>();
  const namespaceRemovals = new Set<string>();
  const namespaceCandidates = new Set<string>();
  const namespacePaths = new Set<string>();
  for (const change of patch.changes) {
    if (authored.has(change.path)) namespaceCandidates.add(change.path);
  }
  for (const path of namespaceCandidates) {
    for (const currentPath of current.keys()) {
      if (currentPath === path) continue;
      if (currentPath.startsWith(`${path}/`) || path.startsWith(`${currentPath}/`)) {
        namespaceRemovals.add(currentPath);
        namespacePaths.add(path);
        warnings.add(`${currentPath}\u0000namespace-wins`);
      }
    }
  }
  for (const path of namespaceRemovals) result.delete(path);

  for (const change of patch.changes) {
    if (namespacePaths.has(change.path)) {
      result.set(change.path, authored.get(change.path) as Uint8Array);
      continue;
    }
    const before = base.get(change.path);
    const existing = current.get(change.path);
    const target = authored.get(change.path);
    if (sameTreeValue(existing, target)) continue;
    if (sameTreeValue(existing, before)) {
      if (target === undefined) result.delete(change.path);
      else result.set(change.path, target);
      continue;
    }
    if (target === undefined) {
      result.delete(change.path);
      if (existing !== undefined) warnings.add(`${change.path}\u0000delete-wins`);
      continue;
    }
    if (before !== undefined && existing === undefined) {
      result.delete(change.path);
      warnings.add(`${change.path}\u0000delete-wins`);
      continue;
    }
    if (before === undefined && existing === undefined) {
      result.set(change.path, target);
      continue;
    }
    if (before === undefined && existing !== undefined) {
      result.set(change.path, target);
      warnings.add(`${change.path}\u0000later-create-wins`);
      continue;
    }
    if (change.type === "put") {
      result.set(change.path, target);
      warnings.add(`${change.path}\u0000later-put-wins`);
      continue;
    }
    const beforeFile = before === undefined ? undefined : classifyFile(before);
    const existingFile = existing === undefined ? undefined : classifyFile(existing);
    const targetFile = classifyFile(target);
    if (
      change.type === "text" &&
      beforeFile?.kind === "text" &&
      existingFile?.kind === "text" &&
      targetFile.kind === "text"
    ) {
      const context = canonicalTextDiff(before as Uint8Array, existing as Uint8Array);
      const transformed =
        context.length === 0 ? change.edit : transformTextEdit(change.edit, context);
      result.set(change.path, applyText(existing, transformed));
    } else {
      result.set(change.path, existing as Uint8Array);
      warnings.add(`${change.path}\u0000put-wins`);
    }
  }
  return {
    tree: result,
    warnings: [...warnings].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  };
}

function replayTarget(
  model: RepositoryModel,
  target: Version,
  exactTrees: Map<string, Tree>,
): ReplayResult {
  if (!targetIsKnown(model, target)) throw new ReplayError("unknown version");
  const selected = model.patches.filter(
    (patch) => patch.revision <= (target.get(patch.author) ?? 0),
  );
  const pending = new Set(selected);
  const warnings = new Set<string>();
  let current: Tree = new Map();
  while (pending.size > 0) {
    const ready = [...pending].filter((patch) => patchReady(patch, pending));
    ready.sort(
      (left, right) =>
        snapCompare(resultVersion(left), resultVersion(right)) ||
        Buffer.from(left.author).compare(Buffer.from(right.author)) ||
        left.revision - right.revision,
    );
    const patch = ready[0];
    if (patch === undefined) throw new ReplayError("cyclic or incomplete patch history");
    const base =
      exactTrees.get(formatVersion(patch.base)) ?? exactMaterialize(model, patch.base, exactTrees);
    const exactResult = applyExactPatch(base, patch);
    const integrated = integratePatch(current, base, patch);
    current = integrated.tree;
    integrated.warnings.forEach((warning) => warnings.add(warning));
    exactTrees.set(formatVersion(resultVersion(patch)), exactResult);
    pending.delete(patch);
  }
  return {
    tree: new Map(
      [...current.entries()].sort(([left], [right]) =>
        Buffer.from(left).compare(Buffer.from(right)),
      ),
    ),
    warnings: [...warnings].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  };
}

/** Validate every patch against its exact causal base and the declared frontier. */
export function validateRepositoryHistory(model: RepositoryModel): void {
  const exactTrees = new Map<string, Tree>([["()", new Map()]]);
  exactMaterialize(model, model.frontier, exactTrees);
}

/** Materialize a known vector, including vectors joined from concurrent heads. */
export function materializeVersion(model: RepositoryModel, target: Version): Tree {
  return replayTarget(model, target, new Map<string, Tree>([["()", new Map()]])).tree;
}

/** Replay the repository frontier using Snap's canonical merge order. */
export function replayRepository(model: RepositoryModel): ReplayResult {
  return replayTarget(model, model.frontier, new Map<string, Tree>([["()", new Map()]]));
}
