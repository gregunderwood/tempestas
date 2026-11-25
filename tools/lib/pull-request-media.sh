# Sourced by tools/pr-screenshots.sh and tools/pr-video.sh: both store what they make on one branch and post it on the PR.
# The caller sets PULL_REQUEST, REPO_ROOT, WORK_DIR and TOOL_NAME, and defines fail.

readonly MEDIA_BRANCH="pr-screenshots"
readonly PUSH_ATTEMPTS=3

HEAD_SHA=""
MEDIA_CHECKOUT=""

require_pull_request_checked_out() {
  local pull_request_head
  pull_request_head="$(gh pr view "$PULL_REQUEST" --json headRefOid --jq .headRefOid)"
  HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [[ "$HEAD_SHA" != "$pull_request_head" ]]; then
    fail "this checkout is at ${HEAD_SHA:0:7}, but PR #$PULL_REQUEST is at ${pull_request_head:0:7}. Check out and push the PR's branch first."
  fi
  if ! git -C "$REPO_ROOT" diff --quiet HEAD; then
    fail "this checkout has uncommitted changes, so what $TOOL_NAME posts would not show commit ${HEAD_SHA:0:7}."
  fi
}

# Only ever adds a commit: every posted comment pins its files to a commit on this branch.
publish_media() {
  local commit_subject=$1
  shift
  say "Pushing to $MEDIA_BRANCH"
  git -C "$REPO_ROOT" fetch --quiet origin "$MEDIA_BRANCH"
  MEDIA_CHECKOUT="$WORK_DIR/$MEDIA_BRANCH"
  git -C "$REPO_ROOT" worktree add --quiet --detach "$MEDIA_CHECKOUT" "origin/$MEDIA_BRANCH"
  mkdir -p "$MEDIA_CHECKOUT/$PULL_REQUEST"
  cp "$@" "$MEDIA_CHECKOUT/$PULL_REQUEST/"
  git -C "$MEDIA_CHECKOUT" add "$PULL_REQUEST"
  if git -C "$MEDIA_CHECKOUT" diff --cached --quiet; then
    return 0
  fi
  git -C "$MEDIA_CHECKOUT" commit --quiet \
    -m "$commit_subject" \
    -m "Made at ${HEAD_SHA:0:7} by tools/$TOOL_NAME.sh."
  push_media_commit
}

# Another run may push first; replaying this one commit on top still only appends.
push_media_commit() {
  local attempt
  for attempt in $(seq 1 "$PUSH_ATTEMPTS"); do
    git -C "$MEDIA_CHECKOUT" push --quiet origin "HEAD:$MEDIA_BRANCH" && return 0
    git -C "$MEDIA_CHECKOUT" fetch --quiet origin "$MEDIA_BRANCH"
    git -C "$MEDIA_CHECKOUT" rebase --quiet "origin/$MEDIA_BRANCH"
  done
  fail "could not push to $MEDIA_BRANCH after $PUSH_ATTEMPTS attempts"
}

# "blob" for an image GitHub shows inline, "raw" for a file it should hand over as a download.
media_url_base() {
  local kind=$1
  echo "https://github.com/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/$kind/$(git -C "$MEDIA_CHECKOUT" rev-parse HEAD)/$PULL_REQUEST"
}

post_marked_comment() {
  local marker=$1 body_file=$2
  local existing_comment
  existing_comment="$(find_marked_comment "$marker")"
  if [[ -n "$existing_comment" ]]; then
    gh api --silent -X PATCH "repos/{owner}/{repo}/issues/comments/$existing_comment" -F body=@"$body_file"
  else
    gh api --silent -X POST "repos/{owner}/{repo}/issues/$PULL_REQUEST/comments" -F body=@"$body_file"
  fi
  echo "  $(gh pr view "$PULL_REQUEST" --json url --jq .url)"
}

find_marked_comment() {
  local marker=$1
  gh api --paginate "repos/{owner}/{repo}/issues/$PULL_REQUEST/comments" \
    --jq ".[] | select(.body | startswith(\"$marker\")) | .id" | head -n 1
}

remove_worktree() {
  local worktree=$1
  [[ -n "$worktree" ]] || return 0
  git -C "$REPO_ROOT" worktree remove --force "$worktree" || true
  rm -rf "$worktree"
}
