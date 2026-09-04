import {
  commit,
  CommandError,
  diff,
  merge,
  loadRepository,
  log,
  repositoryJson,
  revert,
  status,
} from "./commands.js";
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
  renderWarnings,
  presentationMode,
} from "./presentation.js";
import { formatCliVersion, VersionError } from "./versions.js";
import { WorkingTreeError } from "./working_tree.js";
import { HttpRepositoryError, parseServerPort, startRepositoryServer } from "./http.js";

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  presentationMode();
  if (command === "--version" && arguments_.length === 0) {
    process.stdout.write(renderVersion(formatCliVersion(), process.stdout.isTTY));
    return;
  }
  if (command === "--serve" && (arguments_.length === 0 || arguments_.length === 1)) {
    const port = parseServerPort(arguments_[0]);
    const root = findRepositoryRoot(process.cwd());
    if (root === undefined) throw new RepositoryError("not a Snap repository");
    const loaded = await loadRepository(root);
    const server = await startRepositoryServer(repositoryJson(loaded.model), port);
    process.stdout.write(`${server.url}\n`);
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        void server.close().then(resolve, resolve);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
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
  if (command === "merge" && arguments_.length === 1 && arguments_[0] !== undefined) {
    const root = findRepositoryRoot(process.cwd());
    if (root === undefined) throw new RepositoryError("not a Snap repository");
    const operand = arguments_[0];
    const repositoryRoot = /^(?:http|https):\/\//u.test(operand)
      ? operand
      : resolve(process.cwd(), operand);
    const result = await merge(root, repositoryRoot);
    process.stderr.write(renderWarnings(result.warnings, process.stderr.isTTY));
    process.stdout.write(
      renderSuccess("commit", result.version, process.stdout.isTTY).replace("Committed", "Merged"),
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
      const repository = arguments_[3] as string;
      repositoryRoot = /^(?:http|https):\/\//u.test(repository)
        ? repository
        : resolve(process.cwd(), repository);
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
    error instanceof WorkingTreeError ||
    error instanceof HttpRepositoryError
      ? 1
      : 2;
}
