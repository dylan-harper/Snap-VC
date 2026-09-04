import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions } from "../src/versions.js";

function version(entries: ReadonlyArray<readonly [string, number]>): ReadonlyMap<string, number> {
  return new Map(entries);
}

test("compareVersions identifies equal versions", () => {
  assert.equal(
    compareVersions(version([["alice@example.com", 2]]), version([["alice@example.com", 2]])),
    "equal",
  );
});

test("compareVersions identifies a version before another", () => {
  assert.equal(
    compareVersions(version([["alice@example.com", 1]]), version([["alice@example.com", 2]])),
    "before",
  );
});

test("compareVersions identifies a version after another", () => {
  assert.equal(
    compareVersions(version([["alice@example.com", 2]]), version([["alice@example.com", 1]])),
    "after",
  );
});

test("compareVersions identifies concurrent versions", () => {
  assert.equal(
    compareVersions(version([["alice@example.com", 2]]), version([["bob@example.com", 1]])),
    "concurrent",
  );
});
