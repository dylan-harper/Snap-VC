export const MAX_REVISION = Number.MAX_SAFE_INTEGER;

export type Revision = number;
export type VersionPairs = ReadonlyArray<readonly [string, Revision]>;

export type VersionRelation = "equal" | "before" | "after" | "concurrent";

export class VersionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VersionError";
  }
}

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

export function validateContributorId(id: unknown): string {
  if (typeof id !== "string") {
    throw new VersionError(`invalid contributor id: ${String(id)}`);
  }
  if (Buffer.byteLength(id, "utf8") > 254 || /[^\x00-\x7f]/u.test(id)) {
    throw new VersionError(`invalid contributor id: ${id}`);
  }
  if (
    id.length === 0 ||
    /[\u0000-\u001f\u007f\s,()]/u.test(id) ||
    id.includes("->") ||
    id.indexOf("@") !== id.lastIndexOf("@")
  ) {
    throw new VersionError(`invalid contributor id: ${id}`);
  }
  const at = id.indexOf("@");
  if (at <= 0 || at === id.length - 1) {
    throw new VersionError(`invalid contributor id: ${id}`);
  }
  return id;
}

export function validateRevision(value: unknown): Revision {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_REVISION
  ) {
    throw new VersionError("revision must be a positive safe integer");
  }
  return value;
}

export function versionFromPairs(pairs: VersionPairs): ReadonlyMap<string, Revision> {
  const result = new Map<string, Revision>();
  let previous: string | undefined;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new VersionError("invalid version pair");
    }
    const [id, revision] = pair;
    validateContributorId(id);
    validateRevision(revision);
    if (result.has(id)) {
      throw new VersionError(`duplicate contributor in version: ${id}`);
    }
    if (previous !== undefined && utf8Compare(previous, id) >= 0) {
      throw new VersionError("contributors in version are not canonical");
    }
    result.set(id, revision);
    previous = id;
  }
  return result;
}

export function versionToPairs(version: ReadonlyMap<string, Revision>): VersionPairs {
  const entries = [...version.entries()];
  for (const [id, revision] of entries) {
    validateContributorId(id);
    validateRevision(revision);
  }
  return entries
    .sort(([left], [right]) => utf8Compare(left, right))
    .map(([id, revision]) => [id, revision] as const);
}

export function parseVersion(text: unknown): ReadonlyMap<string, Revision> {
  if (typeof text !== "string") {
    throw new VersionError(`invalid version: ${String(text)}`);
  }
  if (text === "()") {
    return new Map();
  }
  if (!text.startsWith("(") || !text.endsWith(")")) {
    throw new VersionError(`invalid version: ${text}`);
  }
  const body = text.slice(1, -1);
  if (body.length === 0) {
    throw new VersionError(`invalid version: ${text}`);
  }
  const pairs: Array<readonly [string, Revision]> = [];
  for (const component of body.split(",")) {
    const arrow = component.indexOf("->");
    if (arrow <= 0 || component.indexOf("->", arrow + 2) !== -1) {
      throw new VersionError(`invalid version: ${text}`);
    }
    const id = component.slice(0, arrow);
    const revisionText = component.slice(arrow + 2);
    if (!/^([1-9][0-9]*)$/u.test(revisionText)) {
      throw new VersionError(`invalid version: ${text}`);
    }
    const revision = Number(revisionText);
    try {
      validateContributorId(id);
      validateRevision(revision);
    } catch {
      throw new VersionError(`invalid version: ${text}`);
    }
    pairs.push([id, revision]);
  }
  return versionFromPairs(pairs);
}

export function formatVersion(version: ReadonlyMap<string, Revision>): string {
  const pairs = versionToPairs(version);
  return pairs.length === 0
    ? "()"
    : `(${pairs.map(([id, revision]) => `${id}->${revision}`).join(",")})`;
}

export function joinVersions(
  left: ReadonlyMap<string, Revision>,
  right: ReadonlyMap<string, Revision>,
): ReadonlyMap<string, Revision> {
  const result = new Map<string, Revision>(left);
  for (const [id, revision] of right) {
    result.set(id, Math.max(result.get(id) ?? 0, revision));
  }
  return result;
}

export function compareVersions(
  left: ReadonlyMap<string, Revision>,
  right: ReadonlyMap<string, Revision>,
): VersionRelation {
  let leftBefore = false;
  let rightBefore = false;
  const ids = new Set([...left.keys(), ...right.keys()]);
  for (const id of ids) {
    const leftRevision = left.get(id) ?? 0;
    const rightRevision = right.get(id) ?? 0;
    if (leftRevision < rightRevision) leftBefore = true;
    if (leftRevision > rightRevision) rightBefore = true;
  }
  if (!leftBefore && !rightBefore) return "equal";
  if (leftBefore && !rightBefore) return "before";
  if (rightBefore && !leftBefore) return "after";
  return "concurrent";
}

/** Total order used only to make concurrent replay deterministic. */
export function snapCompare(
  left: ReadonlyMap<string, Revision>,
  right: ReadonlyMap<string, Revision>,
): number {
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort(utf8Compare);
  for (const id of ids) {
    const difference = (left.get(id) ?? 0) - (right.get(id) ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
