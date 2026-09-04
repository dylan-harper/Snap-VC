import { lstat, open, readdir } from "node:fs/promises";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { basename, join, relative, resolve } from "node:path";

/** A materialized Snap tree: tracked paths mapped to their exact bytes. */
export type WorkingTree = ReadonlyMap<string, Uint8Array>;

export class WorkingTreeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkingTreeError";
  }
}

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function displayPath(path: string): string {
  return path === "" ? "." : path;
}

function unsupported(path: string): never {
  throw new WorkingTreeError(`unsupported working tree entry: ${displayPath(path)}`);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Validate a repository-relative tracked path. */
export function validateTrackedPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new WorkingTreeError("invalid tracked path");
  }
  if (path.includes("\\") || path.includes("\0") || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new WorkingTreeError(`invalid tracked path: ${path}`);
  }
  const parts = path.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    parts[0] === ".snap"
  ) {
    throw new WorkingTreeError(`invalid tracked path: ${path}`);
  }
  return path;
}

/** True when an existing path is an ancestor of another path by segment. */
export function isPathPrefix(prefix: string, path: string): boolean {
  return prefix === path || path.startsWith(`${prefix}/`);
}

/** Check the prefix-free invariant for a tree path collection. */
export function validatePrefixFree(paths: Iterable<string>): void {
  const sorted = [...paths].map(validateTrackedPath).sort(utf8Compare);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && isPathPrefix(previous, current)) {
      throw new WorkingTreeError(`conflicting tracked paths: ${previous} and ${current}`);
    }
  }
}

async function scanDirectory(
  directory: string,
  prefix: string,
  files: Map<string, Uint8Array>,
): Promise<void> {
  let directoryHandle;
  let names: string[];
  try {
    directoryHandle = await open(directory, O_RDONLY | O_NOFOLLOW);
    const directoryStats = await directoryHandle.stat();
    if (!directoryStats.isDirectory()) unsupported(prefix);
    const accessPath = descriptorPath(directoryHandle.fd) ?? directory;
    names = await readDirectoryNames(directory, directoryHandle.fd, directoryStats, prefix);

    names.sort(utf8Compare);
    for (const name of names) {
      if (prefix === "" && name === ".snap") continue;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      validateTrackedPath(path);
      const fullPath = join(accessPath, name);
      let stats;
      try {
        // lstat is deliberate: unsupported entries must never be followed.
        stats = await lstat(fullPath);
      } catch (error) {
        if (isMissing(error)) {
          throw new WorkingTreeError(`working tree entry disappeared: ${path}`);
        }
        throw new WorkingTreeError(`cannot inspect working tree entry: ${path}`);
      }
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        unsupported(path);
      }
      if (stats.isDirectory()) {
        await scanDirectory(fullPath, path, files);
        continue;
      }
      let handle;
      try {
        handle = await open(fullPath, O_RDONLY | O_NOFOLLOW);
        const fileStats = await handle.stat();
        if (!fileStats.isFile()) unsupported(path);
        files.set(path, await handle.readFile());
      } catch (error) {
        if (error instanceof WorkingTreeError) throw error;
        throw new WorkingTreeError(`cannot read working tree file: ${path}`);
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
  } catch (error) {
    if (error instanceof WorkingTreeError) throw error;
    throw new WorkingTreeError(`cannot read working tree: ${displayPath(prefix)}`);
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function readDirectoryNames(
  directory: string,
  fd: number | undefined,
  openedStats: { dev: number; ino: number },
  prefix: string,
): Promise<string[]> {
  const descriptor = descriptorPath(fd);

  if (descriptor !== undefined) {
    try {
      return await readdir(descriptor);
    } catch {
      throw new WorkingTreeError(`cannot read working tree: ${displayPath(prefix)}`);
    }
  }

  // Node 20 has no descriptor-relative readdir API on macOS or Windows.
  // Opening with O_NOFOLLOW and checking the directory identity on both sides
  // of readdir prevents ordinary symlink/replacement attacks and detects a
  // replacement that happens outside the readdir call. A replacement during
  // the call itself cannot be eliminated by the Node API on these platforms;
  // callers needing that stronger guarantee must use a native dirfd walker.
  await assertDirectoryUnchanged(directory, openedStats, prefix);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    throw new WorkingTreeError(`cannot read working tree: ${displayPath(prefix)}`);
  }
  await assertDirectoryUnchanged(directory, openedStats, prefix);
  return names;
}

function descriptorPath(fd: number | undefined): string | undefined {
  if (fd === undefined || process.platform !== "linux") return undefined;
  return `/proc/self/fd/${fd}`;
}

async function assertDirectoryUnchanged(
  directory: string,
  openedStats: { dev: number; ino: number },
  prefix: string,
): Promise<void> {
  const currentStats = await lstat(directory);
  if (
    currentStats.isSymbolicLink() ||
    !currentStats.isDirectory() ||
    currentStats.dev !== openedStats.dev ||
    currentStats.ino !== openedStats.ino
  ) {
    unsupported(prefix);
  }
}

/**
 * Scan regular files below `root`, excluding only the repository's `.snap`
 * directory. Every directory and file is lstat'ed before use, and returned
 * entries are inserted in unsigned UTF-8 path order.
 */
export async function scanWorkingTree(root: string): Promise<WorkingTree> {
  const resolvedRoot = resolve(root);
  let rootStats;
  try {
    rootStats = await lstat(resolvedRoot);
  } catch {
    throw new WorkingTreeError(`cannot inspect working tree: ${resolvedRoot}`);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    unsupported(relative(process.cwd(), resolvedRoot) || basename(resolvedRoot));
  }

  const files = new Map<string, Uint8Array>();
  await scanDirectory(resolvedRoot, "", files);
  return new Map([...files.entries()].sort(([left], [right]) => utf8Compare(left, right)));
}
