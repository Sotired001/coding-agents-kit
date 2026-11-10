# <Project name>

<One or two sentences: what this repository is and who depends on it. Say plainly if real people use it every day,
because that changes how careful an agent has to be.>

- `<dir>/`: <what lives here>
- `<dir>/`: <what lives here>
- Migrations: <how to make one, and the rule that a migration that has run is never edited>

Only rules a person on the team actually wrote down count. An agent does not invent rules and does not treat its own
notes, or another agent's, as rules.

## Checking and shipping

- Work in a worktree, never the main checkout: `npm run wt -- <name>` makes `<worktrees.dir>/<name>` on branch
  `<branchPrefix><name>`, from the tip of the main branch, with dependencies in place. One worktree per task.
  `npm run wt -- <name> --task <id>` links it to a task. Merged, clean, idle worktrees are archived on their own; the
  branch and the local files are kept.
- While working, run only what you are debugging: one test file, one lint. Do not run whole suites to feel safe.
- Run the check gate once, at the end, before the pull request: `npm run check`. It runs every command in
  `agents-kit.config.json` (typecheck, lints, source contracts, <other compilers>) and writes a receipt. If it fails,
  fix the cause and run it again; do not add a duplicate final check of your own.
- `npm run work:status` shows your branch, its checks, its pull request and whether production runs it
  (`-- --all` for every worktree). Use it instead of guessing.
- Tests run after a deploy goes live: first the tests for what that deploy shipped, then the full suite. A failure is
  filed as a task to fix forward. <Or: tests run in the gate. Pick one and say which.>
- Every pull request shows the change working: screenshots of each page or state it changes, a screen recording where
  something moves, taken on demo data, never real customer data. A server-only change shows the output or log that
  proves it.
- <Name the reviewer, human or tool>. Read its review before you merge. Use judgement on its findings and say which
  ones you did not take, and why.
- Whoever builds a change merges it, and whoever merges deploys, right after the merge: `npm run deploy`. A deploy of
  the tip does nothing when production already runs the tip, and when another deploy is already waiting in line it
  leaves the tip to that one, so nobody deploys over anybody.
- A release that fails its health check goes back to the one it replaced by itself. `npm run deploy -- --rollback`
  takes back one that is up but broken. After either, deploys are held until `npm run deploy -- --fixed` ships the fix.
  Code goes back; migrations never do, so a schema change must work with the code already running.
- Ship, then fix forward. When a check after a deploy or a user report shows breakage, fix it with a new commit, and add
  what would have caught it: better code first, then a test or lint, and a line here only when neither can.

## Code rules

- Fail loudly. Never cover a missing value or a failed call with a default, an old value or a second source. Show
  plainly what failed and why.
- When new code replaces old code, delete the old code in the same pull request: its callers, settings and docs too.
  No compatibility paths left working. Version control can bring it back.
- Strict types, no shortcuts past the checker: no `any`, no `x!`, no suppression comments, no cast through `unknown`
  without a `// unchecked: <why>` line above it. `no-shortcuts` enforces it.
- No skipped or focused tests. Make the test pass, or delete it if it no longer holds. `no-skipped-tests` enforces it.
- Build pieces that can be used in more than one place, not one-offs.
- <Dependencies: say whether agents may add packages, and how. For example: nothing downloads packages during a
  build; adding one is a deliberate, reviewed step.>

## Outside the repository

- Before writing code that talks to an outside platform, read that platform's own developer documentation, build it
  the way it says, and cite the page in the pull request.
- Never contact anyone outside the team on the project's behalf: vendors, support, upstream projects.
- No personal data in output, commits, pull requests or tasks: no names, emails, addresses or phone numbers. Use roles.

## Asking for changes

- <Where requests come from, for example one task list, and which requests an agent may start on by itself and
  which wait for a person's approval.>
- Requests are user stories, not designs. Find where the need belongs in what already exists and meet it with the least
  work for the people using it.
