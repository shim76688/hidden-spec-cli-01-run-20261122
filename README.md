[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/shim76688/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/shim76688/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

A command-line patch tool for the make.fun competition
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
It applies the edits AI models write, in four formats, to a tree of files —
and writes every change, or none at all.

    node main.ts [options] [PATCH]

`SPEC.md` is the whole contract. `main.ts` is Node 22 and its standard
library alone: no dependencies, no install step, no network, no clock —
fully deterministic.

## The four formats

- **Unified diffs** (`diff --git`, `---`/`+++` pairs, `@@` hunks): creations
  from `/dev/null` or `new file mode`, deletions, renames and moves
  (`R old -> new`), hunks applied in order with a running offset, the
  nearest occurrence to the hunk's claimed line, and `\ No newline at end
  of file` handling.
- **SEARCH/REPLACE blocks**: a path line (or the previous block's path),
  old lines that must occur exactly once at their tier, else `ambiguous`.
- **V4A patches** (`*** Begin Patch` … `*** End Patch`): Add, Delete and
  Update File sections, `*** Move to:`, `@@ <anchor>` chunks with a cursor
  that moves past each anchor and each write, and `*** End of File` chunks
  that only match at the file's last line.
- **JSON edits**: one array or JSON Lines of `create`, `str_replace` and
  `insert` objects.

## Line matching

Old lines are found at the first of three tiers at which they occur:
tier 0 (exact), tier 1 (trailing whitespace ignored), tier 2 (leading and
trailing whitespace ignored). `--strict` tries tier 0 only. Context lines
are always written as the file's own matched lines; at tier 2 the other
new lines are re-indented from the old lines' leading whitespace to the
file's. CRLF files are written back CRLF, files without a final line break
keep it that way, and a failed edit changes nothing while the edits after
it still run, so every failure is reported (`failed: k of n edits`,
exit 1).

## Grading

The kit's practice set (`check.ts` against
`program/generator/practice.json`, 100 checks across the `cli`, `unified`,
`search-replace`, `v4a` and `json` groups):

    node check.ts /path/to/practice.json

**Practice score: 100 of 100 passed (1000).**

The sealed pool tests sentences the practice set does not show, so the
implementation was also probed against SPEC.md directly: bare `/dev/null`
creation and deletion without a `new file mode` line, malformed `@@` and
`diff --git` lines, a `--- ` line with no `+++ ` after it, hunks before any
section, tier-2 re-indentation from the first line's whitespace, chained
moves (`R a.txt -> c.txt`), V4A anchors at tiers 1 and 2, end-of-file
inserts, and `--check` / `--strict` behaviour.

## The files

- `main.ts`: the entry. Its last lines hand a trial over to `runner.ts`
  when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's trial runner, unchanged.
- `check.ts`: the practice grader, unchanged.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
