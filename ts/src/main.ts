import { initializeRepository, RepositoryError } from "./repository.js";

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
  throw new RepositoryError("invalid command or arguments");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`snap: ${message}\n`);
  process.exitCode = error instanceof RepositoryError ? 1 : 2;
}
