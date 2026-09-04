import { mkdir, readFile, writeFile } from "node:fs/promises";
import { lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const SNAP_DIR = ".snap";
export const REPOSITORY_FILE = "repository.json";

export class RepositoryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

export function repositoryPath(root: string): string {
  return join(root, SNAP_DIR, REPOSITORY_FILE);
}

/** Find the nearest repository containing a Snap metadata file. */
export function findRepositoryRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const snapPath = join(current, SNAP_DIR);
    try {
      const snapStats = lstatSync(snapPath);
      if (snapStats.isSymbolicLink()) {
        throw new RepositoryError(
          `unsupported working tree entry: ${SNAP_DIR}`,
        );
      }
      if (!snapStats.isDirectory()) {
        throw new RepositoryError(`${SNAP_DIR} is not a directory`);
      }
      const repositoryStats = lstatSync(repositoryPath(current));
      if (repositoryStats.isSymbolicLink()) {
        throw new RepositoryError(
          `unsupported working tree entry: ${basename(repositoryPath(current))}`,
        );
      }
      if (repositoryStats.isFile()) return current;
      throw new RepositoryError(`${basename(repositoryPath(current))} is not a regular file`);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // A missing metadata directory or file is normal while walking upward.
      } else {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function rejectInvalidMetadataPath(root: string): void {
  const snapPath = join(root, SNAP_DIR);
  try {
    const snapStats = lstatSync(snapPath);
    if (snapStats.isSymbolicLink()) {
      throw new RepositoryError(`unsupported working tree entry: ${SNAP_DIR}`);
    }
    if (!snapStats.isDirectory()) {
      throw new RepositoryError(`${SNAP_DIR} is not a directory`);
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const repositoryFile = repositoryPath(root);
  try {
    const repositoryStats = lstatSync(repositoryFile);
    if (repositoryStats.isSymbolicLink()) {
      throw new RepositoryError(
        `unsupported working tree entry: ${basename(repositoryFile)}`,
      );
    }
    if (!repositoryStats.isFile()) {
      throw new RepositoryError(`${basename(repositoryFile)} is not a regular file`);
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

function ensureDirectoryPath(path: string): void {
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) {
        const systemAlias =
          process.platform === "darwin" && (current === "/tmp" || current === "/var");
        if (!systemAlias) {
          throw new RepositoryError(`unsupported working tree entry: ${basename(current)}`);
        }
      } else if (!stats.isDirectory()) {
        throw new RepositoryError("cannot initialize over a non-directory");
      }
      break;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        missing.push(current);
        const parent = dirname(current);
        if (parent === current) {
          throw new RepositoryError("cannot create repository path");
        }
        current = parent;
        continue;
      }
      if (error instanceof Error && "code" in error && error.code === "ENOTDIR") {
        throw new RepositoryError("cannot initialize over a non-directory");
      }
      throw error;
    }
  }
  for (const directory of missing.reverse()) {
    mkdirSync(directory);
  }
}

export async function initializeRepository(path: string): Promise<string> {
  const root = resolve(path);
  ensureDirectoryPath(root);
  rejectInvalidMetadataPath(root);
  const existingAncestor = findRepositoryRoot(root);
  if (existingAncestor !== undefined) {
    if (existingAncestor === root) {
      throw new RepositoryError("repository already exists");
    }
    throw new RepositoryError("cannot initialize inside repository");
  }
  await mkdir(join(root, SNAP_DIR), { recursive: true });
  await writeFile(
    repositoryPath(root),
    JSON.stringify({ format: 1, frontier: [], patches: [] }, null, 2) + "\n",
    "utf8",
  );
  return root;
}

export async function readRepositoryJson(root: string): Promise<string> {
  rejectInvalidMetadataPath(root);
  const file = repositoryPath(root);
  try {
    const stats = lstatSync(file);
    if (stats.isSymbolicLink()) {
      throw new RepositoryError(`unsupported working tree entry: ${basename(file)}`);
    }
    if (!stats.isFile()) {
      throw new RepositoryError(`${basename(file)} is not a regular file`);
    }
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new RepositoryError("not a Snap repository");
    }
    throw error;
  }
}
