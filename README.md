# coding-agents-kit

A small set of scripts and one rules template for running several AI coding agents on a single repository, with one
person in charge. It came out of a private production repository where one person runs a handful of agent sessions at
once against a live app that real people use every day. This is the part of that setup that is not tied to the
product.

It is a kit to copy into your repository and change, not a framework or a package. It has no dependencies beyond
Node 24, Git, a POSIX shell, and (for two features) the GitHub CLI.

## The problem

One person, one repository, and five or ten agent sessions working at the same time. Without some structure, the
same things go wrong again and again:

- Two agents edit the same checkout and trample each other's files, or one switches the branch under another.
- Every agent runs the whole test suite "to be safe", several times per task, and the machine grinds.
- An agent says a change is checked when the check ran on different code, or never ran.
- Nobody can tell at a glance which branch has a pull request, which is merged, and which is actually live.
- Two agents deploy at once, or one deploys an older commit over a newer one.
- A broken release stays up while the next merge piles on top of it.
- Agents get past type errors with `any`, `x!` and suppression comments, and get past failing tests with `.skip`.

Each piece below answers one of these.

## The pieces

| Piece | File | Answers |
| --- | --- | --- |
| Worktrees | `src/worktree.ts`, `src/worktree-archive.ts` | one checkout and branch per task; finished ones archived |
| Check gate | `src/check.ts`, `src/check-queue.ts` | one final check, bounded, with a receipt tied to the exact source |
| Source contracts | `src/lints/no-shortcuts.ts`, `src/lints/no-skipped-tests.ts` | the shortcuts agents take under pressure |
| Work status | `src/work-status.ts`, `src/work-state.ts` | where each piece of work is: checks, pull request, live |
| Deploy queue | `src/deploy-queue.ts` | one deploy at a time, the tip wins, automatic rollback, hold until fixed |
| Rules template | `AGENTS.template.md` | how the workflow is written down for the agents |
| Config | `agents-kit.config.json` (examples in `examples/`) | every repo-specific value |

### How they fit

1. A task starts with `npm run wt -- <name>`. The agent gets `.worktrees/<name>` on branch `agent/<name>`, cut from the
   tip of `origin/main`, with `node_modules` (or whatever you list) copied in by reflink, so it is instant on file
   systems that support it. It never touches the main checkout or another agent's worktree.
2. The agent works, running only the single test or lint it is debugging.
3. At the end it runs `npm run check` once. The gate runs the commands you listed, writes a receipt into the
   worktree's own Git directory, and records a fingerprint of HEAD plus every uncommitted and untracked file.
4. It opens a pull request with screenshots or a recording of the change working. A reviewer (a person or another
   model) reviews it. The agent that built it merges it.
5. Whoever merged runs the deploy right away. The deploy queue on the server ships the tip of the main branch, or does
   nothing if the tip is live or another deploy is already waiting to ship it.
6. If the new release fails its health check, the queue switches back and holds further deploys until someone ships
   the fix with `--fixed`.
7. At any point, `npm run work:status -- --all` shows every worktree: task, ahead and behind, local edits, whether the
   receipt still holds, the pull request, and whether production runs it.
8. The next `npm run wt` archives worktrees that are merged, clean, not in use by any process, and idle for two hours.

### Worktrees

`src/worktree.ts <name> [--task <id>]` makes the worktree and then archives finished ones.
`--archive <name>` archives one now and `--archive-merged` archives every finished one.

A worktree is archived only when all of these hold: no process has its working directory inside it (read from
`/proc`), it is not locked, `git status` is clean, it is not the main branch, and its HEAD is either on the main branch
or is the last commit of a merged pull request (so squash merges count, and nothing committed after the merge is lost).
The archive is a tar of the checkout's files, ignored local files included, minus the folders you copy in, plus the
task and receipt files. The branch is kept. A new worktree looks merged (it sits on the tip with nothing in it), so
anything touched within the grace period is left alone.

`worktrees.copyNewest` takes a build folder from whichever checkout built last, skipping named cache folders. It was
written for Rust's `target/` (copy `debug/deps`, skip `incremental`), where a warm build saves minutes per task.

### Check gate

`src/check.ts` runs `checks.commands` through a weighted queue. Give compilers weight 2 and small lints weight 1. With
`"budget": "auto"`, a machine with 16 or more CPUs and 16 GB free runs two compilers side by side, a middling one runs
one compiler plus small checks, and a small one runs everything in turn. The first failure stops queued checks;
running ones finish. Each command runs in its own process group, which is killed on Ctrl-C or on the timeout.

If the source changes while the gate runs, the gate fails: the receipt must describe the code that is on disk. The
receipt goes stale when HEAD, any tracked edit, any untracked file, or the merge base changes. Merging the branch does
not make it stale.

Tests are deliberately not in the default list. In the original setup the gate ran typecheck and source contracts
only, and tests ran on the server after each deploy (first the tests for what that deploy changed, then the full
suite), with failures filed as tasks to fix forward. That trades some safety for agent throughput, and it suits a team
that can fix forward within minutes. If that is not you, add your test command to the list.

### Source contracts

`no-shortcuts` refuses `any`, `x!`, `let x!: T`, `field!: T`, and `x as unknown as T` outside tests, and suppression
comments (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`) everywhere. A cast through `unknown` is
allowed with `// unchecked: <reason>` on the line above.

It needs no TypeScript compiler. Node's built-in type stripper replaces type syntax with spaces and keeps every
position, so a character that is code in the source and a space in the stripped text was type syntax. An `any` there
is the type `any`; a `!` there is an assertion. See the limits below.

`no-skipped-tests` refuses `.only`, `.skip`, `.todo`, `.fixme`, `.fail` on describe/it/test/suite, the `x`/`f`
prefixed forms, `node:test`'s `{ skip: ... }` style options and `t.skip()` / `t.todo()`. It is pattern based.

Both read the files Git tracks, so run them from inside the repository.

### Work status

`src/work-status.ts [--all]` fetches the main branch once, asks `gh pr list` for pull requests, and runs
`status.liveCommand` to learn which commit production runs. The command may print a bare sha, or JSON with the sha
in the field named by `status.liveField` (for example a health endpoint that reports its build). A commit counts as
live when it, or its pull request's merge commit, is an ancestor of the live commit.

### The deploy queue

This piece is a new reference implementation, not extracted code. The original is a long shell script tied to one
server's services, users, databases and alerting, so copying it would have meant copying all of that. What carried
over is the set of rules, which are short:

1. A deploy ships the tip of the branch. When production already runs the tip, it does nothing.
2. At most one deploy waits in line. It ships the tip as the tip is when its turn comes, so a second one waiting would
   only build the same thing again: it says so and exits successfully.
3. A failed build changes nothing that is live.
4. After the switch, the health check runs. If it fails, the queue switches back to the release it replaced, and
   writes a hold.
5. While a hold exists, deploys refuse to run. `--fixed` ships the tip anyway; when that release passes its health
   check, the hold is removed.
6. `--rollback` switches back by hand to the release the live one replaced, and writes a hold.
7. Code goes back; migrations never do. A schema change must work with the code already running.

`src/deploy-queue.ts --config <file>` implements those rules in about 280 lines, using only Node and Git, and its
tests run every rule against throwaway repositories. Layout under `root`: `releases/<sha>-<time>/` (exported with
`git archive`), a `current` symlink switched with one rename, `history.json`, `.rollback-hold.json`, and two lock
files (the deploy lock and the "one waiting" lock). Commands run through `/bin/sh` with `RELEASE_DIR` and
`RELEASE_SHA` set. `onFailure` is told about every failure in `DEPLOY_FAILURE`; in the original setup that became a
task in the team's inbox, so failures got fixed rather than noticed.

It runs on the server. Wire your local `npm run deploy` to it however you reach that server, for example
`ssh <your-host> node /srv/example-app/kit/src/deploy-queue.ts --config /srv/example-app/deploy.json`.

Treat it as a starting point. The original also did things this one does not: a database backup before migrations,
migrations themselves, restarting several services in order, per-tenant health checks, a handover to the newer
commit's own deploy scripts, release receipts, and alerts when the alert path itself fails.

## Adopting it

1. Copy `src/` into your repository, for example as `tools/agents-kit/src/`. Copy `AGENTS.template.md` to `AGENTS.md`
   (or whatever file your agents read) and fill in the placeholders.
2. Add `agents-kit.config.json` at the repository root, starting from `examples/agents-kit.config.json`. Every key is
   optional except the check commands; unknown keys and wrong types are errors.
3. Add `.worktrees/` (or your `worktrees.dir`) to `.gitignore`.
4. Add scripts to `package.json`:

   ```json
   "wt": "node tools/agents-kit/src/worktree.ts",
   "check": "node tools/agents-kit/src/check.ts",
   "work:status": "node tools/agents-kit/src/work-status.ts",
   "deploy": "ssh <your-host> node /srv/example-app/kit/src/deploy-queue.ts --config /srv/example-app/deploy.json"
   ```

5. For the deploy queue: on the server, make a bare clone whose `origin` is your shared repository, and write a deploy
   config starting from `examples/deploy.config.json`.
6. Log in to the GitHub CLI (`gh auth login`) on every machine that makes worktrees or runs work status.

The kit's own TypeScript uses only erasable syntax and `.ts` import paths, so Node runs it directly without a build
step. `tsconfig.json` is there if you want to typecheck it with your own compiler.

## Running the kit's own tests

```
npm test
```

This runs `node --test` over `src/**/*.test.ts`. The tests make throwaway Git repositories in the system temp folder
and point Git at no global or system config, so your own Git settings do not leak in. They need Node 24 or newer, Git
and `tar`; nothing is downloaded.

## Deliberately left out

- Checks across computers. The original sends the heavy compilers to other machines over SSH, against an exact
  snapshot of the source. It is useful but depends on your machines and network, so it is not here.
- The test runner that picks "tests related to your change". It is tied to the original project's layout.
- The post-deploy response check (every read the app makes, answered by the live server and parsed with the app's own
  schemas). It is a good idea and is described in the original project's docs, but it is all product code.
- Screenshot and recording upload for pull requests. The rule is in the template; the script was product specific.
- Build cache sweeping, server recovery, security scanning and anything about one particular server.
- Product-specific source contracts (migration safety, schema duplication, import cycles). Write your own in the same
  shape: a pure function from file and source to findings, a test, and a line in `checks.commands`.

## Limits

- Linux first. Archiving reads `/proc` to see which checkouts are in use and refuses to run elsewhere. Copying uses
  `cp --reflink=auto` (GNU coreutils); on macOS, change `copy()` in `src/worktree.ts`. A process that hides its working
  directory from its owner (systemd's user manager, for one) is named on stderr and assumed not to be in a worktree.
- GitHub only, through the `gh` CLI, for merged pull requests and work status. Branches that are plain ancestors of the
  main branch are recognised without it.
- `no-shortcuts` relies on `stripTypeScriptTypes` from `node:module`, which Node marks experimental. It cannot read
  `.tsx` files (they are skipped), and a `.ts` file using enums, namespaces, parameter properties or `<T>x` assertions
  is reported as unchecked rather than passed. If your code uses those, either adopt TypeScript's
  `erasableSyntaxOnly` style or swap in a parser from the TypeScript compiler. The `// unchecked:` reason must be on
  the line directly above the cast.
- `no-skipped-tests` reads lines, not syntax, so a match inside a string is reported too.
- The deploy queue's locks are files made with exclusive create, holding the owner's pid, and taken over when that
  process has died. `flock(1)` is sturdier on a real server. The queue handles one service on one machine.
- The kit's TypeScript was run, not typechecked: no TypeScript compiler was available offline when it was assembled.
  The tests pass on Node 24.
- The original ran these scripts daily for months, but this generalised copy is new. The tests cover each piece; it has
  not been used in another repository yet.

## Where the code came from

`check-queue.ts`, `worktree-archive.ts` and most of `work-state.ts` are close copies of the originals with names and
paths made configurable. `worktree.ts`, `check.ts` and `work-status.ts` are adapted: the same logic, with the private
server, remote-check workers and schema library taken out and the config added. `config.ts`, both lints and
`deploy-queue.ts` are written new for the kit (the original lints needed a compiler that is not available here, and the
original deploy script was too tied to one server). The tests follow the same split.

## License

MIT. See `LICENSE`.
