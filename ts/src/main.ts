import { commit, CommandError, diff, log, revert, status } from "./commands.js";
import { resolve } from "node:path";
import { ConfigError, writeGlobalConfig, writeLocalConfig } from "./config.js";
import { JsonError } from "./json.js";
import { findRepositoryRoot, initializeRepository, RepositoryError } from "./repository.js";
import { RepositoryModelError } from "./repository_model.js";
import {
  renderError,
  renderDiff,
  renderLog,
  renderStatus,
  renderSuccess,
  renderVersion,
  presentationMode,
} from "./presentation.js";
import { formatCliVersion, VersionError } from "./versions.js";
import { WorkingTreeError } from "./working_tree.js";

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  presentationMode();
  if (command === "--version" && arguments_.length === 0) {
    process.stdout.write(renderVersion(formatCliVersion(), process.stdout.isTTY));
    return;
  }
  if (
    command === "init" &&
    (arguments_.length === 0 || arguments_.length === 1) &&
    !arguments_[0]?.startsWith("-")
  ) {
    const root = arguments_[0] ?? process.cwd();
    await initializeRepository(root);
    process.stdout.write(renderSuccess("init", "()", process.stdout.isTTY));
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
  if (command === "status" && arguments_.length === 0) {
    const root = findRepositoryRoot(process.cwd());
    if (root === undefined) throw new RepositoryError("not a Snap repository");
    process.stdout.write(renderStatus(await status(root), process.stdout.isTTY));
    return;
  }
  if (command === "log" && arguments_.length === 0) {
    const root = findRepositoryRoot(process.cwd());
    if (root === undefined) throw new RepositoryError("not a Snap repository");
    process.stdout.write(renderLog(await log(root), process.stdout.isTTY));
    return;
  }
  if (command === "commit" && arguments_.length === 1 && arguments_[0] !== undefined) {
    const root = findRepositoryRoot(process.cwd());
    if (root === undefined) throw new RepositoryError("not a Snap repository");
    process.stdout.write(
      renderSuccess("commit", await commit(root, arguments_[0]), process.stdout.isTTY),
    );
    return;
  }
  if (command === "revert" && arguments_.length === 1 && arguments_[0] !== undefined) {
    const root = findRepositoryRoot(process.cwd());
    if (root === undefined) throw new RepositoryError("not a Snap repository");
    process.stdout.write(
      renderSuccess("revert", await revert(root, arguments_[0]), process.stdout.isTTY),
    );
    return;
  }
  if (command === "diff") {
    const usage = (): never => {
      throw new CommandError("usage: snap diff <old> <new> [--repo <repository>]");
    };
    if (arguments_.length === 0) {
      const root = findRepositoryRoot(process.cwd());
      if (root === undefined) throw new RepositoryError("not a Snap repository");
      process.stdout.write(renderDiff(await diff(root), process.stdout.isTTY));
      return;
    }
    if (arguments_.length !== 2 && arguments_.length !== 4) usage();
    const oldVersion = arguments_[0];
    const newVersion = arguments_[1];
    if (oldVersion === undefined || newVersion === undefined) usage();
    let repositoryRoot: string | undefined;
    if (arguments_.length === 4) {
      if (arguments_[2] !== "--repo" || arguments_[3] === undefined) usage();
      repositoryRoot = resolve(process.cwd(), arguments_[3] as string);
    }
    const root = findRepositoryRoot(process.cwd());
    if (root === undefined) throw new RepositoryError("not a Snap repository");
    process.stdout.write(
      renderDiff(
        await diff(root, oldVersion as string, newVersion as string, repositoryRoot),
        process.stdout.isTTY,
      ),
    );
    return;
  }
  throw new RepositoryError("invalid command or arguments");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  const rendered = renderError(message, process.stderr.isTTY);
  process.stderr.write(`${rendered}\n`);
  process.exitCode =
    error instanceof RepositoryError ||
    error instanceof ConfigError ||
    error instanceof JsonError ||
    error instanceof VersionError ||
    error instanceof CommandError ||
    error instanceof RepositoryModelError ||
    error instanceof WorkingTreeError
      ? 1
      : 2;
}
