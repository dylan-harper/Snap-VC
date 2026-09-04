import { ConfigError, writeGlobalConfig, writeLocalConfig } from "./config.js";
import { JsonError } from "./json.js";
import { findRepositoryRoot, initializeRepository, RepositoryError } from "./repository.js";
import { VersionError } from "./versions.js";

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (
    command === "init" &&
    (arguments_.length === 0 || arguments_.length === 1) &&
    !arguments_[0]?.startsWith("-")
  ) {
    const root = arguments_[0] ?? process.cwd();
    await initializeRepository(root);
    process.stdout.write("()\n");
    return;
  }
  if (command === "config") {
    const isGlobal = arguments_[0] === "--global";
    const configArguments = isGlobal ? arguments_.slice(1) : arguments_;
    const [configKey, contributorId] = configArguments;
    if (
      configArguments.length !== 2 ||
      configKey !== "contributor.id" ||
      contributorId === undefined
    ) {
      throw new RepositoryError("invalid command or arguments");
    }
    if (isGlobal) {
      await writeGlobalConfig(process.env.HOME, contributorId);
    } else {
      const root = findRepositoryRoot(process.cwd());
      if (root === undefined) throw new RepositoryError("not a Snap repository");
      await writeLocalConfig(root, contributorId);
    }
    return;
  }
  throw new RepositoryError("invalid command or arguments");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`snap: ${message}\n`);
  process.exitCode =
    error instanceof RepositoryError ||
    error instanceof ConfigError ||
    error instanceof JsonError ||
    error instanceof VersionError
      ? 1
      : 2;
}
