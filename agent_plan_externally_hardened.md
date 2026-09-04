# Externally hardened Snap implementation plan

## Objective

Implement the TypeScript Snap CLI so that it passes the complete shared
acceptance suite, while using Darcs as implementation inspiration for patch
semantics, canonicalization, invertibility, and repository integrity.

Snap’s own `SPEC.md` remains authoritative. Darcs is a source of design ideas,
not a second behavioral contract. Snap must retain its smaller scope, vector
clock version format, exact JSON schema, deterministic auto-resolution, and
warning-based conflict behavior.

## External design principles to borrow

Darcs describes a patch as a context-sensitive representation of a change,
with rules for applying, inverting, commuting, merging, checking, and
canonicalizing it. Its documentation also treats a tree as the result of
applying patches to an empty tree and distinguishes sequential from parallel
patches. These ideas map closely to Snap’s causal bases and replay model.

Useful references:

- [Darcs internals overview](https://darcs.net/Internals)
- [Darcs patch internals](https://darcs.net/Internals/Patches)
- [Darcs patch theory and mergers](https://darcs.net/Theory/MergersDocumentation)
- [Darcs repository layout](https://darcs.net/Internals/Repository)
- [Darcs hashes and identity](https://darcs.net/Internals/Hashes)

Apply these ideas selectively:

- Model each Snap patch with explicit `apply`, `check`, `canonicalize`, and
  structural-equality operations.
- Treat patch context/base as a first-class input, never as an inferred or
  mutable side effect.
- Use canonicalization immediately after diff generation and before comparing
  patch values.
- Keep replay from the empty tree as the reference implementation for every
  known version.
- Use reversible internal transformations where practical, especially for OT
  and edit scripts; if a transformation cannot be reversed, reject or resolve
  it explicitly rather than silently changing meaning.
- Separate repository identity from serialized ordering and formatting. Darcs
  distinguishes patch identity from context-dependent storage details; Snap
  should similarly compare parsed typed patches while preserving its exact
  canonical JSON output.
- Use invariant/property tests inspired by Darcs’ emphasis on patch laws:
  apply-after-invert restores the source, canonicalization is idempotent,
  independent file patches commute, and supported merge permutations converge.

Do not import Darcs features that conflict with Snap: named patch bundles,
patch reordering as a user workflow, lazy repositories, cryptographic storage
formats, directory renames, pending patches, conflict-marked repository state,
or Darcs’ historical patch semantics.

## Phase 1: establish the contract and baseline

1. Run `npm ci` and `npm run build` in `ts`.
2. Run `./verify --lang ts` and record the baseline failure shape.
3. Build a requirements matrix from `SPEC.md` and tests `01`–`28`, grouped by
   parser, replay, filesystem, merge, HTTP, CLI, and presentation behavior.
4. Mark every externally inspired design choice as internal-only unless the
   public spec and tests require it.

## Functionality-to-test map

Each implementation slice below names the adjacent documented acceptance tests
that prove it. These YAML cases are end-to-end process tests; the harness tests
under `test-harness/test/harness.test.ts` validate the harness itself. As pure
TypeScript modules are added, supplement these cases with focused unit tests,
but never replace the shared acceptance suite.

| Functionality | Required behavior | Adjacent documented tests |
|---|---|---|
| Repository initialization | Create an empty `.snap` repository, preserve existing files, reject existing/nested repositories, and use the canonical empty version. | `tests/01-init.yaml`, `tests/02-init-paths.yaml` |
| Contributor configuration | Write the exact local config shape, apply local-over-global precedence, reject malformed JSON and invalid IDs. | `tests/03-configuration.yaml`, `tests/25-config-version-path-boundaries.yaml` |
| Contributor IDs and revisions | Validate one-`@` IDs, forbidden characters, byte limits, positive safe-integer revisions, and per-contributor increment rules. | `tests/03-configuration.yaml`, `tests/14-cli-errors.yaml`, `tests/19-version-boundaries.yaml`, `tests/25-config-version-path-boundaries.yaml` |
| Vector versions | Parse/format canonical vectors, distinguish causal comparison outcomes, join componentwise, reject noncanonical/unknown versions, and preserve causal closure. | `tests/19-version-boundaries.yaml`, `tests/21-version-algebra.yaml`, `tests/24-cli-grammar-matrix.yaml`, `tests/25-config-version-path-boundaries.yaml` |
| Strict JSON and repository schema | Reject duplicate keys, unknown fields, malformed numbers/base64, unreachable patches, invalid frontiers, and noncanonical ordering. | `tests/15-repository-validation.yaml`, `tests/23-strict-validation-matrix.yaml`, `tests/27-history-canonicality.yaml` |
| Tracked paths and trees | Enforce UTF-8 relative paths, `.snap` exclusion, prefix-free trees, deterministic byte ordering, and empty-directory exclusion. | `tests/08-unsupported-entries.yaml`, `tests/11-namespace-conflicts.yaml`, `tests/25-config-version-path-boundaries.yaml`, `tests/27-history-canonicality.yaml` |
| Patch validation and replay | Validate exact bases/results, apply patches from the empty tree, reject absent-path/no-op/text-on-binary operations, and preserve history immutability. | `tests/15-repository-validation.yaml`, `tests/23-strict-validation-matrix.yaml`, `tests/27-history-canonicality.yaml` |
| Commit/status/log | Record dirty working trees as canonical patches, sort paths, expose clean/dirty states, and display newest-first history exactly. | `tests/04-commit-status-log.yaml`, `tests/25-config-version-path-boundaries.yaml` |
| Text diff generation | Produce canonical edits and unified diffs, preserve repeated-line alignment and final-newline state. | `tests/05-diff-goldens.yaml` |
| Binary and empty-file handling | Preserve arbitrary bytes, classify binary content, represent empty text files, and render binary add/delete diffs. | `tests/06-binary-and-empty.yaml`, `tests/26-portability-and-failure-safety.yaml` |
| Operational transform | Deterministically transform retain/delete/insert edits, including overlap, splitting, same-position inserts, trailing inserts, and deletion interactions. | `tests/18-three-way-convergence.yaml`, `tests/22-ot-matrix.yaml` |
| Whole-file conflict rules | Apply delete/put, later-put, later-create, identical-put, and sorted warning semantics. | `tests/10-merge-conflicts.yaml`, `tests/17-concurrent-creates.yaml` |
| Namespace conflict rules | Choose deterministic file-versus-descendant winners and materialize a prefix-free result in either merge direction. | `tests/11-namespace-conflicts.yaml` |
| Merge algebra | Union patches idempotently, commute independent changes, associate multi-way merges, and converge independent of direction/order. | `tests/09-merge-text.yaml`, `tests/17-concurrent-creates.yaml`, `tests/18-three-way-convergence.yaml`, `tests/21-version-algebra.yaml`, `tests/22-ot-matrix.yaml` |
| Dot identity/collision | Compare parsed patch values structurally and reject different patches with the same author/revision before mutation. | `tests/16-dot-collision.yaml`, `tests/26-portability-and-failure-safety.yaml` |
| Working-tree safety | Reject observed symlinks/special files, use no-follow file opens where available, refuse dirty merge/revert, and leave metadata/tree unchanged after rejected operations. On macOS/Windows with Node 20, explicitly accept the narrow directory-replacement race during pathname enumeration; native descriptor-relative traversal is future hardening. | `tests/08-unsupported-entries.yaml`, `tests/20-dirty-merge.yaml`, `tests/26-portability-and-failure-safety.yaml` |
| Revert | Restore a known target tree through a new corrective patch, including file/directory transitions, and reject current/unknown/dirty targets. | `tests/07-revert.yaml`, `tests/19-version-boundaries.yaml` |
| Repository exchange | Validate local and HTTP remotes before import, preserve bytes, fetch exact paths once, reject redirects/malformed data, and avoid mutation on failure. | `tests/13-http-client.yaml`, `tests/16-dot-collision.yaml`, `tests/20-dirty-merge.yaml`, `tests/26-portability-and-failure-safety.yaml` |
| HTTP server | Serve an immutable repository snapshot over GET/HEAD, reject other methods/query paths, and exit cleanly on signals. | `tests/12-http-server.yaml` |
| CLI grammar and errors | Reject unknown, misplaced, duplicate, and extra arguments with exact exit channels and diagnostics. | `tests/14-cli-errors.yaml`, `tests/24-cli-grammar-matrix.yaml` |
| Terminal presentation | Match exact plain/ANSI status, log, diff, warning, serve, version, and environment-controlled output. | `tests/04-commit-status-log.yaml`, `tests/05-diff-goldens.yaml`, `tests/28-terminal-presentation.yaml` |

## Phase 2: create a typed, pure core

Use separate modules rather than expanding `main.ts` into a monolith:

`model`, `versions`, `json`, `text-diff`, `ot`, `replay`, `repository`,
`filesystem`, `working-tree`, `http`, `commands`, `presentation`, and `cli`.

Implement first:

- contributor IDs, safe revisions, canonical versions, vector comparison,
  joins, and Snap total order;
- strict JSON parsing with duplicate-key rejection and exact object schemas;
- canonical paths with UTF-8 byte ordering and prefix-free tree validation;
- messages, padded base64, text/binary classification, and edit-token schemas;
- patch constructors that validate their base, dot, result frontier, changes,
  and authored result before they enter repository state.

Every domain value should have a single canonical constructor and formatter.
Avoid using raw objects throughout the code because that makes structural
equality and validation drift likely.

## Phase 3: implement patch laws and replay

Build the reference replay engine around the empty tree:

1. Select exactly the patches required by a known vector version.
2. Verify causal closure and each patch’s base transition.
3. Apply patches in deterministic causal/Snap order.
4. Enforce regular-file semantics, path validity, and prefix freedom after each
   patch, not only at the end.

For every supported patch/edit operation, define and test:

- `check`: valid context, token counts, path state, and result shape;
- `apply`: deterministic tree transformation;
- `canonicalize`: normalized equivalent representation;
- structural equality independent of JSON whitespace/key order;
- inverse or a clear reason why inversion is not part of the public model.

Darcs’ documentation explicitly treats canonicalization as part of diff and
describes inversion of composite patches in reverse order. Snap can use the
same discipline for internal text edits, while keeping revert as Snap’s public
“new corrective patch” operation.

## Phase 4: text diff and OT

- Tokenize text without normalizing CRLF, Unicode, NUL bytes, or final-newline
  state.
- Generate canonical edits using a deterministic LCS-style algorithm, trimming
  identical prefixes/suffixes before the expensive alignment step.
- Coalesce adjacent compatible operations and reject malformed or adjacent
  insert forms required by the spec.
- Implement OT for retain/delete/insert operations with explicit count
  splitting and base-token accounting.
- Test overlapping deletes, same-position inserts, trailing inserts,
  unequal retain/delete counts, and deletion versus insertion.

For each transform, test algebraic properties where applicable:

- both transformed branches apply to the same base;
- both branch orders produce the same final text;
- transforming an already transformed edit is stable;
- no base token is deleted twice;
- inserts do not disappear merely because nearby base tokens were deleted.

Use tests `05`, `06`, `18`, and `22` as the first golden corpus, then extend
with focused internal tests without weakening the shared suite.

## Phase 5: deterministic conflict and namespace resolution

Implement conflict handling as a pure function over all selected patches,
never as “current repository versus incoming repository” state. This prevents
merge direction from affecting the result.

Required rules include:

- independent file changes commute;
- delete/modify, put/put, identical put, and concurrent-create outcomes follow
  `SPEC.md` exactly;
- namespace conflicts choose the specified deterministic winner;
- warnings are generated as facts, sorted canonically, and emitted once;
- identical imports are no-ops;
- patch-set union is idempotent, commutative, and associative;
- same-dot structural disagreement is corruption and aborts before mutation.

Compare all relevant patch values from the common causal context. Do not use
wall-clock timestamps, filesystem order, process order, or merge direction as
tie-breakers.

## Phase 6: repository and filesystem safety

- Load and validate the complete local or remote repository before changing
  anything.
- Treat `.snap/repository.json` as the only required metadata file and exclude
  `.snap` recursively from the tracked tree.
- Discover repositories from nested working directories.
- Inspect with `lstat`; reject symlinks, FIFOs, and other unsupported entries
  observed during scanning without following them.
- Use no-follow file opens where the host and Node runtime provide them. The
  portable pure-TypeScript implementation on macOS and Windows under Node 20
  cannot eliminate the narrow race caused by directory replacement during
  pathname-based `readdir`; make that limitation explicit rather than claiming
  descriptor-level safety that the runtime cannot provide.
- Defer native descriptor-relative directory traversal for POSIX and Windows
  as future hardening. It is not required for the portable implementation and
  must not expand Snap's intentionally small scope without a product decision.
- Compare the working tree and replayed current tree byte-for-byte.
- Build a materialization plan in memory before deleting or replacing paths.
- Apply directory/file transitions safely (`node` versus `node/child`) while
  preserving the prefix-free invariant.
- Write repository JSON only after all validation and materialization planning
  succeeds. Use temporary files plus rename where compatible with the spec.

Borrow Darcs’ separation between inventory/history metadata and pristine tree
state as a conceptual guide, but keep Snap’s simpler single JSON repository
format. Do not add a cache, index, or alternate storage format until tests show
that it is necessary.

## Phase 7: commands, HTTP, and presentation

Implement thin command handlers for `init`, `config`, `status`, `log`, `commit`,
`diff`, `revert`, `merge`, `--serve`, and `--version`.

- Parse CLI grammar centrally and reject unknown, misplaced, duplicate, and
  extra arguments before touching the filesystem.
- Keep local and HTTP repository loading behind one validated repository
  interface; reject redirects and malformed responses as specified.
- Serve an immutable snapshot captured at server startup.
- Centralize error construction so every failure is one stable `snap:` line,
  with no accidental stdout.
- Centralize ANSI/plain rendering and environment precedence for
  `SNAP_COLOR` and `NO_COLOR`.
- Preserve exact output newlines, path ordering, warning ordering, binary diff
  markers, and terminal symbols.

## Phase 8: verification and hardening loop

After each phase:

- run `npm run build`;
- run the narrowest relevant acceptance filters;
- run all directly related convergence and failure-safety cases;
- inspect repository JSON and working-tree bytes after failures;
- run `git diff --check` and review for accidental scope expansion.

Final verification:

```bash
./verify --lang ts
cd test-harness && npm run check && npm test
```

The harness commands are required when harness files change; otherwise the
TypeScript acceptance suite is the primary gate.

## Darcs-inspired property checklist

Before declaring completion, verify these properties with deterministic tests:

- Applying a valid patch to its exact base yields its declared result.
- Replaying a known version from the empty tree is repeatable.
- Canonicalizing twice equals canonicalizing once.
- Independent patches on different paths commute.
- Applying a composite edit and its internal inverse restores the original
  bytes where the operation supports inversion.
- Patch-set union is idempotent, commutative, and associative.
- Merge output is independent of repository direction and merge association.
- A malformed or colliding remote cannot change local metadata or files.
- A failed filesystem materialization does not falsely advance the frontier.
- The only differences between color modes are the specified presentation
  escapes and formatting.

## Definition of done

- Strict TypeScript compilation succeeds.
- All 28 shared acceptance cases pass.
- The implementation remains within Snap’s intentionally narrow scope.
- Repository validation, replay, OT, conflict resolution, filesystem safety,
  HTTP behavior, CLI grammar, and terminal output are each covered by tests.
- Darcs-inspired internals improve lawfulness and testability without changing
  Snap’s public contract.
