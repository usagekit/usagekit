# usagekit operator runbook

Owner procedures for this repository: promoting work to `main`, releasing packages, working
alongside agents, and recovering from the failure modes seen so far. Everything here runs on
the owner's machine; nothing is pushed unless a step says so. Read `README.md` for the rules
these procedures implement.

## 0. Before anything

```sh
cd <workspace>/usagekit
export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH   # pinned Node; ignore the nvm "not installed" warning
git status --short                                        # must be empty unless you know why
git branch --show-current                                 # know whose branch you are on
```

One working directory, one pair of hands. If an agent is running in this directory, do not
run `git checkout`, `git switch`, `git stash`, `git reset` or anything that changes HEAD or
the index. Uncommitted agent work travels across checkouts and lands on whatever branch is
current when the agent commits. If you need `main` while an agent works, use a separate
worktree for read-only tasks only:

```sh
git worktree add --detach /tmp/usagekit-main main    # detached, so the main-protection hook is not involved
# ... inspect ...
git worktree remove /tmp/usagekit-main
```

Do not try to promote or release from a secondary worktree; both scripts assume the primary
checkout.

## 1. Promote a task branch to main

Preconditions: the agent reported done, you reviewed the branch, the tree is clean, hooks are
installed (`npm run setup` once per clone).

```sh
git log --oneline main..<branch>            # what you are approving
npm run approve:main -- --approved-sha $(git rev-parse <branch>) --subject "<type>(<scope>): <title>"
```

What it does: runs the full `npm run check` on the branch, then creates one squash commit
with the reviewed tree and current `main` as sole parent. The approval file lives 60 seconds;
if the checks take longer, rerun the command, it is idempotent. Your task branch stays checked
out and unchanged. Nothing is pushed.

Subject rules: Conventional Commits, one line, no attribution trailers. Bodies in commits are
at most three short lines; longer explanations belong in reports and docs.

Failure: "Another approval is in progress" means a stale approval file from an interrupted
run. It expires within a minute; wait and retry. Do not delete files under `.git/usagekit/`
by hand unless the retry keeps failing after two minutes.

## 2. Release publishable packages

Publishable set: the seven packages in `publishable` in `scripts/lib/release.mjs` (`core`, `store`,
`meter`, `providers`, `views`, `react`, `store-postgres`). All of them are public. The normal path
is the `release.yml` workflow described under Automated package releases in the root README; the
manual steps below remain the fallback.

Preconditions, in order:

1. The version to release is on `main` (all publishable `package.json` files agree).
2. You are logged in: `npm whoami` prints your account. If it prints 401, run `npm login`
   first; tokens from earlier sessions expire.
3. No agent is running in this directory (see section 0).

```sh
git checkout main
V=$(node -p "require('./packages/core/package.json').version")
git tag -s v$V -m "v$V" main
git verify-tag v$V                            # must print: Good "git" signature
npm run release                               # check, build, tarball audit, whoami, publish with 2FA prompt
git checkout <your task branch>
```

The tag must be annotated and signed with the SSH key configured in this repository
(`git config --get user.signingkey`); the allowed-signers file is already set. The script
refuses anything but `main` with the version tag on its exact HEAD.

After a release, verify from the outside, not from your logged-in session:

```sh
for p in core store meter; do curl -s https://registry.npmjs.org/@usagekit/$p | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log(process.argv[1],Object.keys(d.versions||{}),d["dist-tags"])})' $p; done
```

Every package must answer without a token and list the new version under `latest`.

### Release failure modes seen so far

- `ambiguous argument 'v0.2.0^{commit}'`: the tag does not exist. Create and verify it (step
  above), then rerun.
- `401 Unauthorized ... /-/whoami`: expired npm session. `npm login`, then rerun. Nothing was
  published; the script checks identity before touching the registry.
- `409 Conflict ... Failed to save packument`: the registry rejected the write. Wait five
  minutes, then check every package's access before retrying:

  ```sh
  for p in core store meter; do npm access get status @usagekit/$p; done
  ```

  Any package reporting `private` must be restored with
  `npm access set status=public @usagekit/<name>` before the retry. This happened once when
  the publish flag was still `--access restricted`; the flag is `public` now. The script
  publishes packages in order and stops at the first failure, so check which versions exist
  before retrying to avoid a partial set staying partial.

- The script left `.git/usagekit/release.json`: it expires in five minutes; retry after that.

## 3. Work with an agent on this repository

- Hand the agent a work order file outside the repository if it names private hosts, inside
  `docs/` if it does not. The private-terms check rejects private names in tracked files.
- Tell the agent explicitly: no `approve:main`, no `release`, no `publish`, no `git push`, no
  remote, no hook edits, no other repositories, no em dash, no private terms.
- Require an incremental report: created before the first commit, appended after each
  commit. Sessions get interrupted; the report is what survives.
- Require one commit per slice with the full check green, and a clean tree at the end.
- Watch progress from git refs only (`git log main..<branch>`), never from the working tree
  and never by checking the branch out yourself.
- When the agent finishes, verify independently before promoting: `npm run check` on the
  branch, the conformance counts and skipped guarantees per chain, the tarball audit, a grep
  for private terms and em dashes, and a read of the contract diff.

### If an agent commits on the wrong branch

Symptoms: a commit with the agent's subject appears on your branch, or `git status` shows the
agent's files while you are on your branch. Cause: a checkout happened under the agent.

Recovery, done by the agent with your approval, never by both at once:

```sh
git checkout -b <agent-branch> main            # or checkout the existing agent branch
git cherry-pick <stray-sha>                    # move the commit
git branch -f <your-branch> <sha-before-stray> # only if your branch was already promoted or you do not need the stray commit
```

Confirm with `git log --oneline main..<agent-branch>` and a clean tree, then let the agent
continue. Never `git reset --hard` in a directory an agent is using.

## 4. Verify a branch before promotion (checklist)

```sh
npm run check                                            # all gates
npx vitest run 2>&1 | grep -E "Tests |Skipped guarantees" # counts per chain
git grep -c $'\xe2\x80\x94' HEAD -- '*.md' '*.ts'         # em dash: expect no output
git grep -n -i -E "$(tr '\n' '|' < docs/adr/private-terms.txt | sed 's/|$//')" HEAD -- . ':!docs/adr'   # expect no output
git diff main..HEAD -- packages/core/src/contracts.ts    # read every contract change
git status --short                                       # clean
```

Skipped guarantees must be exactly `durable, rollingWindows` on memory, meter and remote
chains and `rollingWindows` on SQLite until a stage changes that on purpose.

## 5. Things that are not automated on purpose

- Owner approval. Scripts check that you ran them; they cannot check that you reviewed.
- Pushing. There is no remote until the repository is hosted; when it is, pushes are a
  separate, explicit step after promotion.
- Registry access changes. `npm access` is run by hand and verified from outside.
- Deleting anything under `.git/usagekit/` or editing hooks.
