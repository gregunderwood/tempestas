---
name: review-round
description: Review a tempestas pull request in rated rounds, or answer one as its author. Covers how to rate findings as blocking, important or nit, the Review round N comment, fixing between rounds, and the Nits addressed clean-up that ends the loop. Use when asked to review a PR, or to address review findings on one.
---

# Review a PR in rounds

The review loop runs for up to three rounds. It ends when a round finds only nits.

## As the reviewer

The reviewer must not be the author of the change. Review the PR fresh each round, against its
issue and against [AGENTS.md](../../../AGENTS.md). Read [docs/Safety.md](../../../docs/Safety.md)
first if anything in the change can energise a relay.

Check that screenshots are on the PR if it changes what a page shows, and a video if it is about
interaction. Both are covered in `/open-pr`. Compare before with after, and watch the video.

Rate each finding:

| Rating        | Means                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| **blocking**  | Wrong behaviour, a safety regression, the issue not done, or the gate failing.         |
| **important** | Should be fixed before merge but is not a bug, such as a missing spec for a real case. |
| **nit**       | Style or taste.                                                                        |

Post **one** PR comment headed `Review round N`, listing each finding with its rating, file and
line, and what is wrong.

## As the author, after a round with blocking or important findings

1. Fix every blocking and important finding, or reply saying why it is declined.
2. Run the gate (see `/open-pr`, step 1) and push.
3. If the fixes change a page or an interaction, refresh the screenshots or video.
4. Start the next round. It reviews afresh rather than only checking the fixes.

## Once a round finds only nits

Clean them up in one pass, with no further review round:

1. Fix each nit that is cheap and clearly right.
2. Leave a nit only if it was already declined for a sound reason, would widen the PR's scope, or is wrong.
3. Run the gate and push.
4. Post one comment headed `Nits addressed`, listing each nit as fixed or left, and why.

The PR is then ready to merge. Merging is the user's call: never merge your own PR.
