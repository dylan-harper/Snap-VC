import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { JsonError, parseJsonUnique } from "./json.js";
import { Utf8Error, decodeUtf8 } from "./utf8.js";
import { validateContributorId } from "./versions.js";

export interface ContributorConfig {
  readonly contributor: {
    readonly id: string;
  };
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const LOCAL_CONFIG_FILE = join(".snap", "config.json");
export const GLOBAL_CONFIG_FILE = ".snapconfig.json";

function configError(message: string): ConfigError {
  return new ConfigError(message);
}

/** Parse and strictly validate the complete on-disk configuration shape. */
export function parseConfig(text: unknown): ContributorConfig {
  let value: unknown;
  if (typeof text === "string") {
    try {
      JSON.parse(text);
    } catch (error) {
      if (error instanceof Error) throw configError(`invalid JSON: ${error.message}`);
      throw configError("invalid JSON");
    }
  }
  try {
    value = parseJsonUnique(text);
  } catch (error) {
    if (error instanceof JsonError) throw configError(error.message);
    if (error instanceof Error) throw configError(`invalid JSON: ${error.message}`);
    throw configError("invalid JSON");
  }
  if (!isRecord(value) || !hasExactly(value, ["contributor"])) {
    throw configError("invalid configuration");
  }
  const contributor = value.contributor;
  if (!isRecord(contributor) || !hasExactly(contributor, ["id"])) {
    throw configError("invalid configuration");
  }
  try {
    const id = validateContributorId(contributor.id);
    return { contributor: { id } };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw configError("invalid contributor id");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

async function readConfigFile(path: string): Promise<ContributorConfig | undefined> {
  await validateConfigParentPath(path);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw configError(`unsupported configuration entry: ${path}`);
  }
  try {
    return parseConfig(decodeUtf8(await readFile(path), "configuration file"));
  } catch (error) {
    if (error instanceof Utf8Error) throw configError(error.message);
    throw error;
  }
}

/** Read local configuration, if present. A malformed local file is an error. */
export function readLocalConfig(root: string): Promise<ContributorConfig | undefined> {
  return readConfigFile(join(root, LOCAL_CONFIG_FILE));
}

/** Read global configuration, if HOME is defined and the file is present. */
export function readGlobalConfig(
  home: string | undefined = process.env.HOME,
): Promise<ContributorConfig | undefined> {
  if (home === undefined || home.length === 0) return Promise.resolve(undefined);
  return readConfigFile(join(home, GLOBAL_CONFIG_FILE));
}

/** Resolve local configuration before global configuration. */
export async function resolveConfig(
  root: string,
  home: string | undefined = process.env.HOME,
): Promise<ContributorConfig | undefined> {
  const local = await readLocalConfig(root);
  return local ?? readGlobalConfig(home);
}

export async function resolveContributorId(
  root: string,
  home: string | undefined = process.env.HOME,
): Promise<string | undefined> {
  return (await resolveConfig(root, home))?.contributor.id;
}

async function writeConfigFile(path: string, id: string): Promise<void> {
  const validated = validateContributorId(id);
  const config = { contributor: { id: validated } };
  await validateConfigParentPath(path);
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw configError(`unsupported configuration entry: ${path}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function validateConfigParentPath(path: string): Promise<void> {
  let current = dirname(path);
  while (true) {
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        const systemAlias =
          process.platform === "darwin" && (current === "/tmp" || current === "/var");
        if (!systemAlias) {
          throw configError(`unsupported configuration entry: ${basename(current)}`);
        }
      } else if (!stats.isDirectory()) {
        throw configError(`unsupported configuration entry: ${basename(current)}`);
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Write the canonical local configuration JSON. */
export function writeLocalConfig(root: string, id: string): Promise<void> {
  return writeConfigFile(join(root, LOCAL_CONFIG_FILE), id);
}

/** Write the canonical global configuration JSON. */
export function writeGlobalConfig(home: string | undefined, id: string): Promise<void> {
  if (home === undefined || home.length === 0) {
    throw configError("HOME is required for global configuration");
  }
  return writeConfigFile(join(home, GLOBAL_CONFIG_FILE), id);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
