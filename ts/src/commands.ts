import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { resolveContributorId } from "./config.js";
import { canonicalTextDiff, classifyFile, renderFileDiff } from "./text_diff.js";
import {
  type Change,
  type EditOperation,
  type Patch,
  parseRepository,
  type RepositoryModel,
  type Tree,
  type Version,
  RepositoryModelError,
} from "./repository_model.js";
import { readRepositoryJson, repositoryPath } from "./repository.js";
import { scanWorkingTree } from "./working_tree.js";
import { formatVersion, parseVersion, snapCompare, versionToPairs } from "./versions.js";
import { fetchRepositoryJson } from "./http.js";

export class CommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function applyText(base: Uint8Array | undefined, edit: readonly EditOperation[]): Uint8Array {
  const oldFile = base === undefined ? undefined : classifyFile(base);
  if (oldFile?.kind === "binary") throw new CommandError("text change applied to binary content");
  const oldTokens = oldFile?.tokens ?? [];
  const output: string[] = [];
  let cursor = 0;
  for (const operation of edit) {
    if ("retain" in operation) {
      output.push(...oldTokens.slice(cursor, cursor + operation.retain));
      cursor += operation.retain;
    } else if ("delete" in operation) {
      cursor += operation.delete;
    } else output.push(...operation.insert);
  }
  if (cursor !== oldTokens.length) throw new CommandError("edit does not consume old content");
  return new Uint8Array(Buffer.from(output.join(""), "utf8"));
}

function applyChange(tree: Map<string, Uint8Array>, change: Change): void {
  const old = tree.get(change.path);
  if (change.type === "delete") tree.delete(change.path);
  else if (change.type === "put") tree.set(change.path, new Uint8Array(change.content));
  else tree.set(change.path, applyText(old, change.edit));
}

/** Replay histories whose selected patches have materializable single-patch bases. */
export function materializeVersion(model: RepositoryModel, target: Version): Tree {
  const built = new Map<string, Tree>([[formatVersion(new Map()), new Map()]]);
  const pending = new Set(
    model.patches.filter((patch) => patch.revision <= (target.get(patch.author) ?? 0)),
  );
  while (pending.size > 0) {
    const ready = [...pending].filter((patch) =>
      [...patch.base].every(([id, revision]) => {
        for (let number = 1; number <= revision; number += 1) {
          const dependency = model.patches.find(
            (candidate) => candidate.author === id && candidate.revision === number,
          );
          if (dependency !== undefined && pending.has(dependency)) return false;
        }
        return true;
      }),
    );
    ready.sort(
      (left, right) =>
        snapCompare(
          new Map([...left.base, [left.author, left.revision]]),
          new Map([...right.base, [right.author, right.revision]]),
        ) ||
        Buffer.from(left.author).compare(Buffer.from(right.author)) ||
        left.revision - right.revision,
    );
    const patch = ready[0];
    if (patch === undefined) throw new CommandError("unsupported concurrent patch history");
    const baseTree = built.get(formatVersion(patch.base));
    if (baseTree === undefined) throw new CommandError("unsupported concurrent patch history");
    const nextTree = new Map(baseTree);
    for (const change of patch.changes) applyChange(nextTree, change);
    const resultVersion = new Map(patch.base);
    resultVersion.set(patch.author, patch.revision);
    built.set(formatVersion(resultVersion), nextTree);
    pending.delete(patch);
  }
  const frontierTree = built.get(formatVersion(target));
  if (frontierTree === undefined) {
    throw new CommandError("unsupported concurrent patch history");
  }
  return new Map(
    [...frontierTree.entries()].sort(([left], [right]) =>
      Buffer.from(left).compare(Buffer.from(right)),
    ),
  );
}

export function materializeLinearRepository(model: RepositoryModel): Tree {
  return materializeVersion(model, model.frontier);
}

export async function loadRepository(root: string): Promise<{
  readonly model: RepositoryModel;
  readonly tree: Tree;
}> {
  try {
    const model = parseRepository(await readRepositoryJson(root));
    return { model, tree: materializeLinearRepository(model) };
  } catch (error) {
    if (error instanceof CommandError || error instanceof RepositoryModelError) throw error;
    throw new CommandError(error instanceof Error ? error.message : "invalid repository");
  }
}

async function loadRepositoryJson(json: string): Promise<{
  readonly model: RepositoryModel;
  readonly tree: Tree;
}> {
  try {
    const model = parseRepository(json);
    return { model, tree: materializeLinearRepository(model) };
  } catch (error) {
    if (error instanceof CommandError || error instanceof RepositoryModelError) throw error;
    throw new CommandError(error instanceof Error ? error.message : "invalid repository");
  }
}

function patchFingerprint(patch: Patch): string {
  return JSON.stringify({
    author: patch.author,
    revision: patch.revision,
    base: versionToPairs(patch.base),
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
  });
}

function checkPatchCollisions(left: RepositoryModel, right: RepositoryModel): void {
  const patches = new Map(
    left.patches.map((patch) => [`${patch.author}\u0000${patch.revision}`, patch]),
  );
  for (const patch of right.patches) {
    const existing = patches.get(`${patch.author}\u0000${patch.revision}`);
    if (existing !== undefined && patchFingerprint(existing) !== patchFingerprint(patch)) {
      throw new CommandError(`patch collision: ${patch.author} revision ${patch.revision}`);
    }
  }
}

function renderTreeDiff(oldTree: Tree, newTree: Tree): string {
  let output = "";
  for (const path of sortedPaths(oldTree, newTree)) {
    output += renderFileDiff(path, oldTree.get(path), newTree.get(path));
  }
  return output;
}

export async function diff(
  root: string,
  oldText?: string,
  newText?: string,
  repositoryRoot?: string,
): Promise<string> {
  const local = await loadRepository(root);
  if (oldText === undefined && newText === undefined) {
    return renderTreeDiff(local.tree, await scanWorkingTree(root));
  }
  if (oldText === undefined || newText === undefined) {
    throw new CommandError("usage: snap diff <old> <new> [--repo <repository>]");
  }
  let oldVersion: Version;
  let newVersion: Version;
  try {
    oldVersion = parseVersion(oldText);
  } catch {
    throw new CommandError(`invalid version: ${oldText}`);
  }
  try {
    newVersion = parseVersion(newText);
  } catch {
    throw new CommandError(`invalid version: ${newText}`);
  }
  const other =
    repositoryRoot === undefined
      ? local
      : /^(?:http|https):\/\//u.test(repositoryRoot)
        ? await loadRepositoryJson(await fetchRepositoryJson(repositoryRoot))
        : await loadRepository(repositoryRoot);
  if (repositoryRoot !== undefined) checkPatchCollisions(local.model, other.model);
  let oldTree: Tree;
  let newTree: Tree;
  try {
    oldTree = materializeVersion(local.model, oldVersion);
  } catch {
    throw new CommandError(`unknown version: ${oldText}`);
  }
  try {
    newTree = materializeVersion(other.model, newVersion);
  } catch {
    throw new CommandError(`unknown version: ${newText}`);
  }
  return renderTreeDiff(oldTree, newTree);
}

function sortedPaths(left: Tree, right: Tree): string[] {
  return [...new Set([...left.keys(), ...right.keys()])].sort((a, b) =>
    Buffer.from(a).compare(Buffer.from(b)),
  );
}

export async function status(root: string): Promise<string> {
  const { model, tree } = await loadRepository(root);
  const actual = await scanWorkingTree(root);
  let output = `version ${formatVersion(model.frontier)}\n`;
  for (const path of sortedPaths(tree, actual)) {
    const old = tree.get(path);
    const next = actual.get(path);
    const code =
      old === undefined ? "A" : next === undefined ? "D" : equalBytes(old, next) ? "" : "M";
    if (code !== "") output += `${code} ${path}\n`;
  }
  return output;
}

function escapeMessage(message: string): string {
  return message.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");
}

export async function log(root: string): Promise<string> {
  const { model } = await loadRepository(root);
  return [...model.patches]
    .reverse()
    .map(
      (patch) =>
        `${formatVersion(new Map([...patch.base, [patch.author, patch.revision]]))}\t${patch.author}\t${escapeMessage(patch.message)}\n`,
    )
    .join("");
}

function changesForCommit(oldTree: Tree, newTree: Tree): Change[] {
  const changes: Change[] = [];
  for (const path of sortedPaths(oldTree, newTree)) {
    const old = oldTree.get(path);
    const next = newTree.get(path);
    if (next === undefined) {
      if (old !== undefined) changes.push({ type: "delete", path });
      continue;
    }
    if (old !== undefined && equalBytes(old, next)) continue;
    const nextFile = classifyFile(next);
    const oldFile = old === undefined ? undefined : classifyFile(old);
    if (nextFile.kind === "text" && (old === undefined || oldFile?.kind === "text")) {
      changes.push({ type: "text", path, edit: canonicalTextDiff(old ?? new Uint8Array(), next) });
    } else changes.push({ type: "put", path, content: new Uint8Array(next) });
  }
  return changes;
}

export function repositoryJson(model: RepositoryModel): string {
  return `${JSON.stringify(
    {
      format: 1,
      frontier: versionToPairs(model.frontier),
      patches: [...model.patches]
        .sort(
          (left, right) =>
            Buffer.from(left.author).compare(Buffer.from(right.author)) ||
            left.revision - right.revision,
        )
        .map((patch) => ({
          author: patch.author,
          revision: patch.revision,
          base: versionToPairs(patch.base),
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
    },
    null,
    2,
  )}\n`;
}

async function writeRepository(root: string, model: RepositoryModel): Promise<void> {
  const target = repositoryPath(root);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, repositoryJson(model), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeWorkingTree(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new CommandError("cannot read working tree");
  }
  for (const entry of entries) {
    if (entry.name === ".snap") continue;
    const path = `${root}/${entry.name}`;
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      throw new CommandError(`cannot inspect working tree entry: ${entry.name}`);
    }
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      throw new CommandError(`unsupported working tree entry: ${entry.name}`);
    }
    if (stats.isDirectory()) {
      await removeWorkingTree(path);
      await rmdir(path);
    } else {
      await unlink(path);
    }
  }
}

async function installTree(root: string, tree: Tree): Promise<void> {
  await removeWorkingTree(root);
  const paths = [...tree.keys()].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  for (const path of paths) {
    const parts = path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = `${current}/${part}`;
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink() || stats.isFile()) {
          await unlink(current);
          await mkdir(current);
        } else if (!stats.isDirectory()) {
          throw new CommandError(`unsupported working tree entry: ${path}`);
        }
      } catch (error) {
        if (error instanceof CommandError) throw error;
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          await mkdir(current);
        } else throw error;
      }
    }
    const filePath = `${root}/${path}`;
    await writeFile(filePath, tree.get(path) as Uint8Array, { flag: "w" });
  }
}

export async function commit(
  root: string,
  message: string,
  home = process.env.HOME,
): Promise<string> {
  if (message.length === 0 || Buffer.byteLength(message, "utf8") > 4096) {
    throw new CommandError("invalid commit message");
  }
  const { model, tree } = await loadRepository(root);
  const actual = await scanWorkingTree(root);
  const changes = changesForCommit(tree, actual);
  if (changes.length === 0) throw new CommandError("working tree is clean");
  const author = await resolveContributorId(root, home);
  if (author === undefined) throw new CommandError("contributor id is not configured");
  const revision = (model.frontier.get(author) ?? 0) + 1;
  const patch: Patch = { author, revision, base: model.frontier, message, changes };
  const frontier = new Map(model.frontier);
  frontier.set(author, revision);
  const next: RepositoryModel = { format: 1, frontier, patches: [...model.patches, patch] };
  parseRepository(repositoryJson(next));
  await writeRepository(root, next);
  return formatVersion(frontier);
}

export async function revert(
  root: string,
  targetText: string,
  home = process.env.HOME,
): Promise<string> {
  let target: Version;
  try {
    target = parseVersion(targetText);
  } catch {
    throw new CommandError(`invalid version: ${targetText}`);
  }
  const { model, tree } = await loadRepository(root);
  const actual = await scanWorkingTree(root);
  if (!treesEqual(tree, actual)) throw new CommandError("working tree is dirty");
  let targetTree: Tree;
  try {
    targetTree = materializeVersion(model, target);
  } catch {
    throw new CommandError(`unknown version: ${targetText}`);
  }
  if (treesEqual(tree, targetTree)) throw new CommandError("target tree is already current");
  const author = await resolveContributorId(root, home);
  if (author === undefined) {
    throw new CommandError("contributor.id is required; configure it locally or globally");
  }
  const revision = (model.frontier.get(author) ?? 0) + 1;
  const patch: Patch = {
    author,
    revision,
    base: model.frontier,
    message: `revert to ${formatVersion(target)}`,
    changes: changesForCommit(tree, targetTree),
  };
  const frontier = new Map(model.frontier);
  frontier.set(author, revision);
  const next: RepositoryModel = { format: 1, frontier, patches: [...model.patches, patch] };
  parseRepository(repositoryJson(next));
  await installTree(root, targetTree);
  await writeRepository(root, next);
  return formatVersion(frontier);
}

function treesEqual(left: Tree, right: Tree): boolean {
  if (left.size !== right.size) return false;
  for (const [path, bytes] of left) {
    const other = right.get(path);
    if (other === undefined || !equalBytes(bytes, other)) return false;
  }
  return true;
}
