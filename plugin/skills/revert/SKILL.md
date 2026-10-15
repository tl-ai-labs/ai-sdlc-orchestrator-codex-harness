---
name: revert
description: "Undo the file changes made by a specific brownfield run, restoring each touched file from git or from the run's own backups. Refuses when a later run touched the same files."
---

Revert a specific brownfield run. Takes one required argument: the `run-id`, which matches the
directory name under `.sdlc/runs/`, e.g. `20260812-193020-bugfix-a7f3c1`.

This is destructive — it removes files the run created and restores files it edited. Always confirm
with the user before executing. Never assume force.

# 1. Locate the run and read its plan

The project root is the git top-level folder of the current directory (`git rev-parse
--show-toplevel`). Find `<project-root>/.sdlc/runs/<run-id>/`. If it does not exist, print the
available run IDs (from `.sdlc/ledger.json`, or by listing `.sdlc/runs/`) and exit.

The record of what the run changed is `.sdlc/runs/<run-id>/provenance.json`. Code writes it, never
the model: `write-contract.mjs --freeze` opens it at Gate 0, the write hook snapshots each file
before the run's first allowed write to it (backing up a file that held uncommitted or untracked
content), and the end of the run closes it: close-out, an abandoned run, or the end of a headless run.
Closing it reconciles against `git status` and the run's commits, so a write the hook could not see
(a shell edit, a lockfile rewrite, an agent worker) is recorded too. A file that was there before the
run but that `git status` did not list at its start (an ignored file, for example) is listed in
`unrecorded_changes`, never planned for deletion. Never edit the record or its `backups/` folder.

`<plugin-root>` in the command below is this plugin's own folder. Codex gave you this skill's file
path with the skill; it ends in `/skills/revert/SKILL.md`, and the plugin root is that path with the
ending removed (two folders above this file). Put it in the command in place of `<plugin-root>` and
keep the single quotes: the path can contain spaces. If no path came with the skill, `ls -d
"${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/mmo-codex/*/` lists the installed copies; use the
newest version.

Get the plan from the record, in a shell call of its own, run from inside the project:

```bash
node '<plugin-root>/scripts/write-provenance.mjs' --plan --run-id=<run-id>
```

It reads the record of the git project the current directory is in (`project_root` in its output
names it), and changes nothing. If it exits non-zero, print its message and stop. It refuses while
any run holds the project's write contract (a live run would snapshot this revert's own commands),
and for a run with no readable record: then say *"Cannot revert run &lt;run-id&gt;: its provenance record
is missing or unreadable. Manual revert via git diff is the only option."*

It prints JSON:

| Field | Meaning |
|---|---|
| `finalized` | `false` when the record has no `finalized_at`: the run never closed (a killed session). Say so: each file's last state is unknown, so every file is a dirty case below. |
| `git_head_before` | The commit the run started from. |
| `commits` | Commits made between the run's start and its end. |
| `files[]` | One entry per file the run changed: `path`, `action`, `command`, `reason`, `conflict`, `recorded_by` (`hook`, `finalize` or `cli`). |
| `unrecorded_changes[]` | Changes no snapshot saw: `path`, `reason`, and `has_record` (whether `files[]` also covers it). |

Each `files[]` entry's `action`:

| `action` | What it does | Record signals behind it |
|---|---|---|
| `git-checkout` | `git checkout <git_head_before> -- <path>` | `existed_before:true, tracked_in_git:true, dirty_before:false` |
| `restore-backup` | Copies the run's backup of the pre-run content back | `existed_before:true` with `backup_path` set (uncommitted or untracked before the run) |
| `delete` | Removes a file the run created | `existed_before:false` |
| `none` | Nothing to do: already as before the run, or a new file already gone | `sha_before` equals the file on disk now, or git finds no difference from `git_head_before` |
| `cannot` | Not restorable; `reason` says why | `dirty_before:true` or untracked, with no backup; or a path, backup or commit in the record that fails the plan's checks (outside the project, under `.git/` or `.sdlc/`, a backup outside this run's `backups/`) |

`command` is the exact shell command for that file, with absolute paths, or null.

# 2. Check for dirty cases

A file whose `conflict` is set is a **dirty case**. Do not run its command without the user's
choice. `conflict` says which case it is:

| `conflict` begins | What it means |
|---|---|
| `a later run also wrote it` | A later run's `provenance.json` lists the path, and its `started_at` is later. |
| `the run did not close` | The record has no `finalized_at`, so the file's last state is unknown. |
| `it changed after the run` | Its hash on disk differs from `sha_after`. |
| `close-out found it` | `recorded_by: finalize`, whatever the `action`: `git status` or the run's commits show the change, but no snapshot saw the run write it. It is a shell edit the hook could not read, or the user's own edit made while the run was going (during a gate pause, for example). When it adds `outside the run's confirmed allowlist`, the run had no leave to write it, so it is most likely the user's. |

**On a `close-out found it` case**, show the change (`git diff <git_head_before> -- <path>` for a
file git tracks, the file itself for a new one) and ask before making changes:

```
File src/mine.ts changed during run <run-id>, but the run was not seen writing it:
  · close-out found it in git status
  · it is outside the run's confirmed allowlist
  · it may be your own edit, made while the run was going
Options:
  1. Restore src/mine.ts as the plan says (this change is lost).
  2. Keep it as it is.
Reply with 1, 2, or `abort`.
```

**On any other dirty case**, show the diff and stop before making changes:

```
File src/auth/login.ts is dirty:
  · This run wrote it (sha_after: abc...)
  · Later run 20260813-... also wrote it
  · Current on-disk content differs from both
Cannot safely auto-revert. Options:
  1. Revert the LATER run first, then re-run this command.
  2. Restore src/auth/login.ts as the plan says anyway, and continue.
  3. Skip this file — revert only the clean files.
Reply with 1, 2, 3, or `abort`.
```

List every `cannot` file and every `unrecorded_changes` entry with `has_record:false` as not
restorable, with its reason. An `unrecorded_changes` entry with `has_record:true` is restored by
its `files[]` command; say what the reason says happened.

# 3. Revert the clean files

Collect the `command` of every file that is not a dirty case (and of each dirty case the user chose
to restore), show them to the user for approval, then run them from the project root. Print each
command's result. If any fails, halt and print what succeeded versus what still needs manual
attention.

A `git-checkout` command restores the working tree and the index. A `restore-backup` or `delete`
command changes the working tree only: if the run staged or committed that file, the index keeps
the run's version, and `git status` then shows the file as changed against it. Say which files
that leaves, for the user to stage (`git add -A -- <path>`) or leave.

If `commits` is non-empty, the run committed as it went. Say that the run's commits remain in
history, and offer `git revert <commit>` (newest first) instead when the user wants reverse
commits rather than a working-tree edit.

Run the plan again afterwards: every reverted file now shows `action: "none"`.

# 4. Backup file cleanup

After a successful revert, the per-run backup copies under `.sdlc/runs/<run-id>/backups/` become
obsolete. Ask before deleting: *"Revert complete. Delete backup copies at
.sdlc/runs/&lt;run-id&gt;/backups/? Reply `yes` to delete, `no` to keep."*

Default to KEEP if the user just presses enter — keeping backups is cheap and undoing an accidental
delete is expensive.

# 5. Ledger entry

Append a row to `.sdlc/ledger.md` and `.sdlc/ledger.json`:

```
| <timestamp> | revert | — | -N files reverted (originally from run <run-id>) |
```

Include a `revert_of: <run-id>` field in the ledger.json entry, so a later audit can trace reverts
to their targets.

# 6. Do NOT

- **Do NOT** call `git reset --hard` or `git clean -fd`. Those are too broad and would blow away
  unrelated work.
- **Do NOT** modify files the plan does not list, even if you suspect they were affected. The
  record is the authoritative account; anything outside it is not this run's territory.
- **Do NOT** delete the run directory `.sdlc/runs/<run-id>/`. Keep it as a record that a revert
  happened.
- **Do NOT** work out a file's action yourself from `provenance.json`. A tracked file that held
  uncommitted work before the run has a `sha_before` and a backup, and a `git checkout` of it would
  throw that work away; the plan tells the two apart.
- **Do NOT** proceed for a `cannot` file. Print clearly what cannot be reverted and let the user
  decide.

# 7. Argument surface

These are words the user adds after the run-id when invoking this skill. They are read from the
message, not passed to the plan command.

```
<run-id>                  # interactive; confirms before every destructive step
<run-id> skip-dirty       # revert clean files only; leave dirty ones alone
<run-id> dry-run          # print the plan; do not execute
<run-id> keep-backups     # skip the backup-cleanup prompt
```

There is no force option. To override the dirty check for one file, the user runs that file's
`command` from the plan themselves. Never offer `git checkout <sha> -- <path>` for it: for a file
that held uncommitted work before the run (`action: restore-backup`), that throws the work away.
This skill's job is to prevent losing work by accident; a force flag would defeat that.
