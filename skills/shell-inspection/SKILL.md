# Shell Inspection

Use this skill when the task benefits from quick workspace inspection or simple structure checks.

Typical use cases:
- finding repeated mentions across files
- counting matches or lines
- listing files or confirming file sets
- previewing the start or end of files
- checking simple JSON structure

Do not use this skill for:
- declared validation commands that must be rerun exactly
- large brittle one-liners
- replacing careful semantic review with shallow pattern matching

## Workflow

1. Prefer shell when it is the shortest truthful way to inspect the workspace.
2. Keep commands short and inspectable.
3. Prefer one clear command over a long chain.
4. Use file reads when semantic detail matters more than speed.
5. Stop once the shell result answers the current question.

## Good patterns

- search text:
  - `rg "pattern" .`
- count matches:
  - `rg "pattern" file.md | wc -l`
- list files:
  - `find . -maxdepth 2 -type f | sort`
- preview content:
  - `head -n 20 file.md`
  - `tail -n 20 file.md`
- simple uniqueness checks:
  - `sort items.txt | uniq -c`
- simple JSON inspection:
  - `jq '.items[] | .name' file.json`

## Avoid

- giant one-liners that are hard to debug
- repeated `cat` / `fs_read` loops when one shell query would answer faster
- inventing alternate validators when the contract already names one
