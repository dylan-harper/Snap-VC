# Snap

Snap is a small local version control system built around vector-clock
versions, patch replay, and deterministic automatic merging. It is deliberately
compact: eight everyday commands plus a read-only HTTP mode, with most of the
challenge concentrated in exact semantics and correctness.

Interactive output is designed for humans: status and history have readable
layouts, diffs use semantic colors, and successful operations, warnings, and
errors have distinct symbols. Redirected output stays plain and byte-stable for
scripts. Set `SNAP_COLOR=always` to preserve the terminal presentation through
a pipe, `SNAP_COLOR=never` to disable it, or `NO_COLOR=1` for Snap's
conservative plain-output opt-out.

## At a glance

- **Focus:** causal modelling, canonical data formats, deterministic diffs,
  operational transform, filesystem materialization, and process-level tests.
- **Expected difficulty:** high, but slightly smaller than TabbyShell. The CLI
  is narrow; replay, conflict rules, and validation require care.
- **Prerequisites:** Node.js 20.19+, 22.13+, or 24+. Snap itself uses no API key or
  network service.
- **Implementation:** This checkout contains the TypeScript implementation in
  `ts/`. The runner also supports Rust and Scala implementations when those
  directories are present.

## What’s here

- [`SPEC.md`](SPEC.md) — the canonical behavioral contract.
- [`tests/`](tests/) — language-neutral YAML acceptance tests.
- [`TEST-HARNESS.md`](TEST-HARNESS.md) and [`test-harness/`](test-harness/) —
  the extensible process/filesystem/HTTP test format and driver.
- `ts/` — the TypeScript implementation.
- `run` — the bundled launcher; it selects the most recently modified
  available language implementation, or accepts `--lang`.
- `verify` — the public acceptance-test entry point.

## Run Snap

From the repository root:

```bash
SNAP_ROOT="$(pwd)"
SNAP_DEMO="$(mktemp -d "${TMPDIR:-/tmp}/snap-example.XXXXXX")"
./run init "$SNAP_DEMO"
(
  cd "$SNAP_DEMO"
  "$SNAP_ROOT/run" config contributor.id you@example.com
  printf 'hello\n' > hello.txt
  "$SNAP_ROOT/run" commit "add greeting"
)
```

This example writes configuration only inside the temporary demonstration
repository. Remove `"$SNAP_DEMO"` when you are finished with it.

Choose the bundled implementation language explicitly when needed:

```bash
./run --lang ts --version
```

The supported surface is:

```text
snap init [path]
snap config [--global] contributor.id <id>
snap status
snap log
snap commit <message>
snap diff [<old> <new> [--repo <repository>]]
snap revert <version>
snap merge <repository>
snap --serve [port]
snap --version
```

Read the spec before relying on familiar Git behavior: Snap has no branches,
staging area, checkout, or unresolved conflicts.

## Verify

Run the full language-neutral acceptance suite against your selected workspace:

```bash
./verify --lang ts
```

The verifier installs locked TypeScript dependencies when needed and executes
the candidate through `tsx`. Run the implementation checks directly when
developing:

```bash
cd ts
npm ci
npm run build
npm run lint
```

If Rust or Scala implementations are added, the verifier can be invoked with
`--lang rust` or `--lang scala`; it builds those workspaces before running the
suite.

Or test any executable implemented in any language:

```bash
./verify --candidate /path/to/snap
```

The YAML suite creates isolated temporary repositories and checks exact output,
history JSON, file bytes, directory state, merge convergence, and HTTP behavior.
It imports no TypeScript implementation code.
