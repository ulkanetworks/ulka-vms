---
paths:
  - "CHANGELOG.md"
  - "ARCHITECTURE.md"
  - "README.md"
  - "CLAUDE.md"
  - ".claude/rules/**"
---
# Writing the docs

## CLAUDE.md and the rules files
- Write rules, not inventories: name modules, functions and tests, not lists of files; never copy a value the code
  holds (name its constant). When a test enforces a rule, name it in the rule.
- Backticks mark text that appears in this repo as written: `TestDocNames` fails when it no longer does. Names from
  elsewhere go without backticks.
- A rules file's `paths` list every folder its rules matter in; a new area gets a file and a row in the root's map.

## CHANGELOG.md
For people running and using Ulka VMS, shown as the Changelog page: a `## <Month Year>` section per month, newest
first, with `### New` and `### Fixed`, one line each starting with its product (`**Video: …**` in New, `Video: …` in
Fixed; Video, Workspace, Developers). Only what people can newly do, or what didn't work for them, in their words.

## README.md and ARCHITECTURE.md
The README is for a stranger: what it is, getting started, usage, development, deployment, licence. ARCHITECTURE.md
is the map: modules, boundaries, processes, and how an application builds on Ulka VMS (`app.Extension`). Update it
when a module, a boundary rule or an extension point changes.

`docs/` and `data/` are git-ignored: plans and local notes never get committed.
