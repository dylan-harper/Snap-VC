import assert from "node:assert/strict";
import test from "node:test";
import { renderError, renderVersion, useTerminalPresentation } from "../src/presentation.js";

type PresentationEnvironment = {
  readonly snapColor?: string;
  readonly noColor?: string;
};

function withEnvironment<T>(environment: PresentationEnvironment, callback: () => T): T {
  const previousSnapColor = process.env.SNAP_COLOR;
  const previousNoColor = process.env.NO_COLOR;
  if (environment.snapColor === undefined) delete process.env.SNAP_COLOR;
  else process.env.SNAP_COLOR = environment.snapColor;
  if (environment.noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = environment.noColor;
  try {
    return callback();
  } finally {
    if (previousSnapColor === undefined) delete process.env.SNAP_COLOR;
    else process.env.SNAP_COLOR = previousSnapColor;
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
}

test("auto selects stdout presentation from stdout TTY state", () => {
  withEnvironment({}, () => {
    assert.equal(renderVersion("snap 1.0.0", true), "\u001b[1msnap 1.0.0\u001b[0m\n");
    assert.equal(renderVersion("snap 1.0.0", false), "snap 1.0.0\n");
  });
});

test("auto selects stderr presentation from stderr TTY state", () => {
  withEnvironment({}, () => {
    assert.equal(renderError("bad input", true), "\u001b[31m✗ snap: bad input\u001b[0m");
    assert.equal(renderError("bad input", false), "snap: bad input");
  });
});

test("NO_COLOR disables auto presentation on TTY streams", () => {
  withEnvironment({ noColor: "" }, () => {
    assert.equal(useTerminalPresentation(true), false);
    assert.equal(useTerminalPresentation(false), false);
  });
});

test("SNAP_COLOR=always overrides NO_COLOR for both stream states", () => {
  withEnvironment({ snapColor: "always", noColor: "1" }, () => {
    assert.equal(useTerminalPresentation(true), true);
    assert.equal(useTerminalPresentation(false), true);
  });
});

test("SNAP_COLOR=never disables presentation even for TTY streams", () => {
  withEnvironment({ snapColor: "never" }, () => {
    assert.equal(useTerminalPresentation(true), false);
    assert.equal(useTerminalPresentation(false), false);
  });
});

test("terminal rendering emits the specified ANSI bytes", () => {
  withEnvironment({ snapColor: "always" }, () => {
    assert.equal(renderVersion("snap 1.0.0", false), "\u001b[1msnap 1.0.0\u001b[0m\n");
    assert.equal(renderError("bad input", false), "\u001b[31m✗ snap: bad input\u001b[0m");
  });
});
