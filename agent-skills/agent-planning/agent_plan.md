# Snap implementation plan

## Goal

Implement the TypeScript Snap CLI so that `./verify --lang ts` passes all 28
language-neutral acceptance files, while preserving the canonical spec and the
harness contract.

## Principles

- Treat `SPEC.md` and the YAML suite as authoritative; resolve ambiguities in
  both before coding.
- Keep the core deterministic and mostly pure. Put filesystem, HTTP, process,
  and terminal effects at the edges.
- Validate complete inputs and remote histories before mutating local metadata
  or the working tree.
- Use strict TypeScript, no `any`, `node:` imports, canonical ordering, and
  stable error/output helpers.
- Add focused YAML regressions whenever implementation work exposes a contract
  gap. Do not replace shared acceptance coverage with private tests.

## Phases

### 1. Baseline and contract extraction

- Run the harness checks and the TypeScript build to establish the baseline.
- Run the verifier once to record the expected placeholder failures.
- Read the relevant spec sections alongside each failing acceptance file.
- Create a small requirements matrix mapping each command and invariant to the
  planned module and acceptance cases.

### 2. Domain model and canonical codecs

Implement and unit-test internal value types for:

- contributor IDs and safe positive revisions;
- vector versions, canonical parse/format, comparison, join, and Snap order;
- strict unique-key JSON parsing and canonical repository/config schemas;
- tracked paths, UTF-8 byte ordering, prefix-free maps, base64, messages, and
  text edit tokens.

Make structural equality explicit for patches so same-dot identity and remote
collision detection compare parsed values rather than JSON formatting.

### 3. Text and replay core

- Implement text tokenization that preserves CRLF, NUL/binary classification,
  Unicode, and final-newline state.
- Implement canonical diff/edit generation and exact edit validation, including
  non-adjacent operation requirements and token consumption.
- Implement replay from the empty tree with causal-base checks, create/replace/
  delete semantics, and prefix-free enforcement.
- Implement vector selection of known versions and deterministic patch order.

Keep this layer independent of the filesystem so it can be tested against
crafted histories and convergence cases.

### 4. Operational transform and conflict resolution

- Implement pairwise and multi-way text OT for retain/delete/insert operations.
- Cover overlapping deletes, insert-vs-insert priority, trailing inserts,
  unequal count splitting, and deletion/insertion interaction.
- Implement deterministic whole-file rules: delete-wins, put-wins, later-put,
  later-create, identical-value collapse, and sorted warning facts.
- Resolve path namespace conflicts using the specified canonical winner and
  ensure merge order cannot change the result.
- Exercise `17`, `18`, `21`, and `22` repeatedly after each core change.

### 5. Repository, working tree, and materialization

- Load `.snap/repository.json` and optional config with strict schemas and
  canonical history checks.
- Discover the repository root from nested directories.
- Inspect regular files without following symlinks; ignore `.snap`; reject
  unsupported entries and empty directories.
- Compare working tree/current tree byte-for-byte and implement safe materialized
  tree replacement for commit, merge, and revert.
- Ensure every failure path validates first and leaves repository JSON/tree
  unchanged where the spec requires it.

### 6. Commands and presentation

Implement the exact command surface in small dispatchers:

- `init`, `config`, `status`, `log`, `commit`;
- `diff` for working-tree and known-version ranges, including `--repo`;
- `revert` as a new corrective patch;
- `merge` for local paths and HTTP repository URLs;
- `--serve` with immutable snapshot semantics and GET/HEAD behavior;
- `--version` and strict argument grammar.

Centralize plain/color output, `SNAP_COLOR`/`NO_COLOR` precedence, stable error
messages, ANSI formatting, and exit handling. Match exact newlines and avoid
printing partial success before a later failure.

### 7. Verification and hardening

- After each vertical slice run `npm run build` and the focused YAML filter.
- Run the full required command: `./verify --lang ts`.
- For harness changes, run `cd test-harness && npm run check && npm test`.
- Inspect failures by category: schema, replay, filesystem, HTTP, CLI, then
  presentation; fix the lowest-level invariant first.
- Re-run portability and failure-safety cases on the target environment.
- Review repository status and ensure generated dependencies/build artifacts are
  not accidentally committed.

## Suggested module boundaries

Use separate TypeScript modules rather than expanding `main.ts` into a monolith:

`model`/`versions`, `json`, `text-diff`, `ot`, `repository`, `replay`,
`filesystem`, `working-tree`, `http`, `commands`, `presentation`, and `cli`.
Keep public CLI dispatch thin and make error types/formatting reusable.

## Definition of done

- TypeScript compiles under its strict config.
- All 28 acceptance cases pass through the shared harness.
- Malformed local and remote histories cannot mutate state.
- Merge is deterministic, convergent, idempotent, and warns exactly as specified.
- Byte preservation and canonical JSON/output are verified.
- No out-of-scope Git features are introduced.
