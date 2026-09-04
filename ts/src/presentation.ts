import { RepositoryError } from "./repository.js";

export type PresentationMode = "auto" | "always" | "never";
export type SuccessCommand = "init" | "commit";

const ESC = "\u001b[";

export function presentationMode(): PresentationMode {
  const value = process.env.SNAP_COLOR;
  if (value === undefined || value === "auto") return "auto";
  if (value === "always" || value === "never") return value;
  throw new RepositoryError("SNAP_COLOR must be auto, always, or never");
}

export function useTerminalPresentation(isTty: boolean | undefined): boolean {
  const mode = presentationMode();
  return (
    mode === "always" || (mode === "auto" && isTty === true && process.env.NO_COLOR === undefined)
  );
}

function style(code: number, text: string): string {
  return `${ESC}${code}m${text}${ESC}0m`;
}

function colorize(text: string, code: number, enabled: boolean): string {
  return enabled ? style(code, text) : text;
}

export function renderVersion(version: string, isTty: boolean | undefined): string {
  return `${colorize(version, 1, useTerminalPresentation(isTty))}\n`;
}

export function renderSuccess(
  command: SuccessCommand,
  version: string,
  isTty: boolean | undefined,
): string {
  const enabled = useTerminalPresentation(isTty);
  if (!enabled) return `${version}\n`;
  const label = command === "init" ? "Initialized repository" : "Committed";
  return `${style(32, "✓")} ${style(1, label)} ${style(36, version)}\n`;
}

export function renderStatus(plain: string, isTty: boolean | undefined): string {
  const enabled = useTerminalPresentation(isTty);
  if (!enabled) return plain;
  const lines = plain === "" ? [] : plain.split("\n").filter((line) => line !== "");
  const versionLine = lines.shift();
  if (versionLine === undefined || !versionLine.startsWith("version ")) return plain;
  const version = versionLine.slice("version ".length);
  let output = `${style(1, "Snap status")}  ${style(36, version)}\n\n`;
  if (lines.length === 0) return `${output}  ${style(32, "✓")} Working tree clean\n`;
  for (const line of lines) {
    const match = /^(A|D|M) (.*)$/.exec(line);
    if (match === null) return plain;
    const [, code, path] = match;
    const details: readonly [number, string, string] =
      code === "A"
        ? [32, "+", "added"]
        : code === "D"
          ? [31, "−", "deleted"]
          : [33, "~", "modified"];
    output += `  ${style(details[0], details[1])} ${path} ${style(2, `(${details[2]})`)}\n`;
  }
  return output;
}

export function renderLog(plain: string, isTty: boolean | undefined): string {
  const enabled = useTerminalPresentation(isTty);
  if (!enabled || plain === "") return plain;
  const entries: Array<readonly [string, string, string]> = [];
  for (const line of plain.split("\n").filter((line) => line !== "")) {
    const fields = line.split("\t");
    const version = fields[0];
    const author = fields[1];
    const message = fields[2];
    if (
      fields.length !== 3 ||
      version === undefined ||
      author === undefined ||
      message === undefined
    ) {
      return plain;
    }
    entries.push([version, author, message]);
  }
  return entries
    .map(
      ([version, author, message]) =>
        `${style(36, "●")} ${style(1, message)}\n  ${style(36, version)} ${style(2, "by")} ${style(35, author)}\n`,
    )
    .join("\n");
}

export function renderError(message: string, isTty: boolean | undefined): string {
  try {
    return colorize(`snap: ${message}`, 31, useTerminalPresentation(isTty));
  } catch {
    return `snap: ${message}`;
  }
}
