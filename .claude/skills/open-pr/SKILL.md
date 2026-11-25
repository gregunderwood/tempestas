---
name: open-pr
description: Open a pull request for tempestas the way this repo expects. Covers the gate, the PR body, before-and-after screenshots, and the video with its player artifact. Use when a branch's work is done and is ready for a PR, or when a PR's screenshots or video need posting or refreshing.
---

# Open a PR

The work is on its own branch, `<issue#>-<short-slug>` off `main`, for one issue. Follow these steps in order.

## 1. Run the gate

Run it before opening the PR, not after.

```bash
npx nx run-many -t lint,typecheck,test,build,migration-round-trip
npx nx test server --coverage
```

- `migration-round-trip` needs Docker running.
- Coverage thresholds are checked only by the `--coverage` run.
- In a worktree, check `NX_WORKSPACE_ROOT_PATH` first. If it points at the main checkout, Nx
  checks the main checkout and still reports success. Prefix every call with
  `NX_WORKSPACE_ROOT_PATH=$PWD NX_DAEMON=false`, and give the worktree its own `node_modules`
  (`cp -al` from the main checkout, never a symlink).

If anything fails, fix it before going on.

## 2. Commit and push

- Use a conventional-commit subject (`feat(web):`, `fix(server):`, `docs:`) with a body that says why.
- Add `Signed-off-by` (`git commit -s`).
- **Never add a `Co-Authored-By` trailer or any other AI attribution.**

## 3. Open the PR

Write the body in this shape:

```markdown
Closes #N.

<One paragraph on why the change was needed.>

## What changed

- **A bold sentence for each change.** Then any detail.

## Verified locally

<The gate, plus anything run on real hardware or a real stack.>

## After merge

<Deploys and hardware steps still to do. Say what is deliberately left out and which issue tracks it.>
```

If the branch has been deployed to elantris for a bench test, say so under Verified locally,
because the box is then running code `main` does not have.

## 4. Post screenshots if the PR changes what a page shows

Shoot before and after, at desktop and phone width, before review starts. Run from the PR's
pushed, clean head:

```bash
tools/pr-screenshots.sh <pr> <page>...                # e.g. 138 dashboard nodes
tools/pr-screenshots.sh --after-only <pr> <page>...   # a page that did not exist before
tools/pr-screenshots.sh --history <pr> <page>...      # with 30 days of simulated history
```

A state the fake driver cannot produce, such as a follower or a failing node, is shot with the
e2e smoke test's stubbed API and fake socket instead. Details: [docs/Testing.md, Screenshots on a
PR](../../../docs/Testing.md#screenshots-on-a-pr).

## 5. Post a video if the PR is about interaction or touches a stack spec

1. Run `tools/pr-video.sh <pr>` from the PR's pushed, clean head. Add spec paths to record only those.
2. Publish `dist/pr-video/<pr>/index.html` as an artifact, with `videos.json` and the mp4s as its files.
3. Run `tools/pr-video.sh --player-url <artifact-url> <pr>` to put the player link into the comment.

After a new recording, republish to the same artifact and run `--player-url` again. Details:
[docs/Testing.md, Video of a PR](../../../docs/Testing.md#video-of-a-pr).

## 6. Hand over to review

Review then follows [review-round](../review-round/SKILL.md). Merging is the user's call: never
merge your own PR, and never push to `main`.
