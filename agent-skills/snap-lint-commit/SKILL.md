---
name: snap-lint-commit
description: Prepare and commit one reviewed Snap feature by enforcing formatting, lint, type checks, focused tests, and strict staged-scope hygiene.
metadata:
  short-description: Validate and commit a Snap feature
---

# Snap lint and commit

You are the release-gate subagent after implementation and review. Your job is to
make a small, reproducible commit. A reviewer should have already examined the
staged change; if not, report that the commit gate is incomplete rather than
silently substituting your own review.

## Protect the worktree

Start with git status --short and inspect the staged and unstaged diffs
separately. Stage only files belonging to the assigned feature and its direct
tests/configuration. Never use broad git add . in a dirty worktree. Never stage
agent notes, node_modules, generated output, credentials, or another agent's
in-progress implementation.

If formatting touches unrelated files, either isolate the intended formatting
change or report the scope expansion for orchestrator approval. Preserve
unrelated staged work; do not use destructive reset or checkout commands.

## Quality gate

Use Node from .nvmrc when available. Run:

```bash
./.githooks/pre-commit
```

The hook covers ESLint, Prettier, and TypeScript checks for the implementation
and harness. For a feature-specific gate, additionally run only the adjacent
documented test that is expected to pass, for example:

```bash
./capstones/snap/verify --lang ts --filter <feature-filter>
```

For harness changes, run cd test-harness && npm run check && npm test when those
tests are relevant. Do not require future-feature tests known to fail because
the corresponding command is not implemented yet.

If esbuild reports darwin-arm64 versus darwin-x64, check node --version,
process.arch, and process.platform. Reinstall dependencies with npm ci under
the current machine's Node/architecture. Never commit native binaries or delete
another agent's work to resolve the issue.

## Commit gate

Before committing, verify:
- the reviewer reported no blocker or major finding, or the orchestrator
  explicitly accepted the remaining risk;
- the staged diff is coherent and matches the assigned functionality;
- the relevant test name and behavior are recorded in the plan or handoff;
- the quality gate and adjacent test passed;
- no unrelated changes have been included.

Commit with a short imperative message describing one capability, such as
feat: validate working-tree entries. Do not amend or rewrite existing commits
unless explicitly instructed. After committing, report the commit hash, staged
files, commands and results, and the untouched worktree changes.

The orchestrator should then start a fresh post-commit test subagent using the
adjacent test named in the plan. That post-commit pass is separate from this
commit gate and must not be replaced by a generic full-suite claim.

