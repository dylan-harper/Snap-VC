# Snap repository understanding

## Executive summary

Snap is a deliberately small local version-control system. Its central model is
an immutable, causally complete set of patches addressed by contributor/revision
dots. Versions are vector clocks; merge is validated patch-set union followed
by deterministic replay and frontier join. There are no branches, staging,
checkout, push, authentication, object storage, or unresolved-conflict mode.

The repository is a workshop scaffold with three intended implementation
languages (TypeScript, Rust, and Scala), one language-neutral YAML acceptance
suite, and a process/filesystem/HTTP test harness. In this checkout only the
TypeScript edition is present, and `ts/src/main.ts` is still a placeholder that
prints `snap: not implemented` and exits unsuccessfully. The harness and tests
are the strongest sources of executable behavior.

## Sources of truth and working rules

- `SPEC.md` is the normative product contract. It defines data formats,
  validation, replay, text diff/operational transform, conflict winners,
  filesystem rules, HTTP, CLI grammar, output, and failure safety.
- `tests/01-*.yaml` through `tests/28-*.yaml` are public, implementation-neutral
  acceptance cases. Exact stdout, stderr, exit codes, JSON, bytes, trees,
  warnings, HTTP requests, and convergence are observable behavior.
- `AGENTS.md` requires contract changes to be made in the spec and accompanied
  by a YAML regression case. It also requires the harness to remain portable
  and tagged unions to evolve additively.
- Verification is `./verify --lang ts`; harness changes additionally require
  `cd test-harness && npm run check && npm test`.

## Repository map

### Root guidance, documentation, and launchers

- `AGENTS.md`: agent/development policy; emphasizes spec-first behavior,
  separation of responsibilities, shared acceptance testing, and scope control.
- `README.md`: user-facing overview, supported commands, output color controls,
  setup, and verification instructions.
- `SPEC.md`: complete canonical contract. Key invariants include valid canonical
  vector clocks, one immutable patch per dot, complete causal bases, strict
  JSON/path/message/edit validation, prefix-free trees, deterministic replay,
  idempotent/commutative/associative import, and metadata exclusion.
- `TEST-HARNESS.md`: public YAML format and security/process semantics. It
  specifies typed sandbox operations, interpolation, captures, foreground and
  background processes, controlled HTTP, exact assertions, limits, and cleanup.
- `run`: strict Bash implementation selector/launcher. It can choose the
  newest available TypeScript/Rust/Scala implementation or accept `--lang`;
  it may install/build language dependencies.
- `run_tests`: strict Bash wrapper for the harness. It handles `--lang` or
  `--candidate`, prepares implementations, installs locked harness deps, and
  launches the harness CLI.
- `verify`: thin strict wrapper delegating to `run_tests` from the repository
  location.

### Test harness

- `test-harness/package.json`: private ESM package with `check`, `test`, and
  `run` scripts; uses `yaml`, TypeScript, `tsx`, and Node typings.
- `test-harness/package-lock.json`: npm v3 lockfile pinning the harness and
  platform-specific transitive dependencies.
- `test-harness/tsconfig.json`: strict ES2022/no-emit TypeScript configuration
  for `src` and `test`.
- `src/types.ts`: discriminated-union public model for YAML cases, steps,
  process/HTTP/state assertions, captures, and results. Runtime validation is
  still required because types cannot enforce all cross-field constraints.
- `src/yaml-loader.ts`: discovers byte-sorted YAML files and validates format 1,
  tagged variants, fields, ranges, regex/base64, captures, and exit assertions.
- `src/runner.ts`: executes typed filesystem, process, HTTP, and assertion steps
  in isolated sandboxes with interpolation, deadlines, cleanup, and optional
  failed-sandbox retention.
- `src/filesystem.ts`: confined, symlink-aware fixture operations plus
  deterministic tree snapshots; supports files, directories, links, removal,
  copying, and POSIX FIFOs.
- `src/process.ts`: detached child-process execution, strict UTF-8 capture,
  input, readiness, timeout/overflow limits, and process-group termination.
- `src/http-server.ts`: controlled loopback route server and HTTP client with
  request recording, response limits, normalized headers, and special HEAD
  handling.
- `src/assertions.ts`: exact process, HTTP, filesystem, tree, JSON, path, and
  request assertions with interpolated values.
- `src/interpolate.ts`: single-pass placeholder expansion with built-ins,
  escaped braces, strict names, unknown-variable errors, and recursive JSON
  interpolation.
- `src/json.ts`: JSON parsing plus duplicate-key and trailing-content rejection.
- `src/reporter.ts`: human and summary output for pass/fail results, durations,
  failures, sandboxes, and optional captured streams.
- `src/cli.ts`: harness CLI option parsing, test discovery/filtering, sequential
  execution, reporting, summaries, and exit-code policy.
- `test/harness.test.ts`: harness-level coverage for schema validation,
  interpolation, JSON uniqueness, processes, timeouts, sandbox security,
  HTTP/background operations, assertions, and cleanup.

The harness is mostly complete and itself is a security-sensitive component.
Important risks are platform-specific FIFOs/signals, symlink and timeout races,
process-group cleanup, raw HEAD parsing, output/body caps, and the distinction
between runtime validation and TypeScript types.

### TypeScript implementation

- `ts/AGENTS.md`: repeats strict TypeScript and spec/test requirements; forbids
  `any` and asks for `node:` built-ins.
- `ts/package.json`: private ESM package; `start` runs source through `tsx`, and
  `build` only type-checks (`tsc --noEmit`). There is no implementation test
  script.
- `ts/package-lock.json`: locked development toolchain and esbuild platform
  binaries.
- `ts/tsconfig.json`: strict ES2022 ESM/no-emit configuration for `src`.
- `ts/snap`: location-independent POSIX launcher for `src/main.ts` via local
  `tsx`.
- `ts/src/main.ts`: current nonfunctional placeholder. It emits one error and
  sets exit code 1; all Snap behavior remains to be implemented.

## Acceptance-suite coverage by theme

- `01-init`, `02-init-paths`: valid empty repository layout, preservation of
  existing files, repeated/nested init failures, and path creation.
- `03-configuration`: local-over-global contributor configuration, malformed
  JSON, exact config replacement, and contributor-ID validation.
- `04-commit-status-log`: sorted status, arbitrary legal messages, revisions,
  history formatting, deletes/modifications/additions, and clean-commit failure.
- `05-diff-goldens`, `06-binary-and-empty`: canonical unified text diffs,
  repeated-line alignment, missing-newline markers, empty files, binary puts,
  and exact byte preservation.
- `07-revert`, `08-unsupported-entries`: tree rollback as a new patch, dirty
  refusal, and rejection of symlinks/FIFOs without mutation.
- `09-merge-text`, `10-merge-conflicts`, `11-namespace-conflicts`: concurrent
  text OT, delete/put/binary conflict winners, namespace winners, warnings,
  idempotence, and direction-independent convergence.
- `12-http-server`, `13-http-client`: immutable served snapshots, GET/HEAD/
  method behavior, signals, remote diff/merge, invalid JSON, no redirects, and
  exact request counts.
- `14-cli-errors`, `24-cli-grammar-matrix`: version output, repository and
  argument errors, option placement/duplication, diff usage, ports, and no
  accidental filesystem effects.
- `15-repository-validation`, `23-strict-validation-matrix`,
  `27-history-canonicality`: duplicate JSON keys, unknown fields, canonical
  ordering, valid bases and transitions, text edit token accounting, path
  rules, reachability, prefix conflicts, and validation-before-mutation.
- `16-dot-collision`: structurally different same-dot patches are corruption
  and must not alter local state.
- `17-concurrent-creates`, `18-three-way-convergence`, `21-version-algebra`,
  `22-ot-matrix`: deterministic tie-breaking, vector algebra, multi-way merge
  associativity, insertion/deletion interactions, and OT edge cases.
- `19-version-boundaries`, `25-config-version-path-boundaries`: canonical
  version boundaries, nested repository discovery, safe integer limits, IDs,
  Unicode/UTF-8 path ordering, metadata/empty-directory exclusion, and config.
- `20-dirty-merge`, `26-portability-and-failure-safety`: reject dirty or
  unsupported local trees, preserve CRLF/NUL/Unicode bytes, reject malformed
  remotes, fetch once, and avoid mutation on failed validation.
- `28-terminal-presentation`: exact ANSI/plain presentation, environment
  precedence, symbols, spacing, colors, warnings, diffs, serving, and version.

## Architectural implications

The implementation should be layered around a pure core and effectful edges:

1. Value types and canonical parsers for IDs, versions, JSON, paths, base64,
   edits, patches, repositories, and errors.
2. Pure text tokenization/diff, edit validation, OT, vector comparisons, patch
   replay, and deterministic conflict resolution.
3. Repository loading/validation and materialization planning, with all remote
   data validated before local writes.
4. Filesystem and working-tree inspection/materialization with `.snap` excluded,
   prefix-free enforcement, unsupported-entry rejection, and dirty checks.
5. Commands, HTTP serving/fetching, presentation, and strict CLI dispatch.

The biggest correctness hazards are not ordinary command plumbing: they are
canonical serialization, causal closure, replay invariants, byte-vs-text
classification, OT convergence, namespace conflicts, validation-before-write,
and exact output. The current scaffold gives no implementation shortcuts.

