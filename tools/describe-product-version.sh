#!/usr/bin/env bash
# tools/describe-product-version.sh [repository]
# Prints the last vX.Y.Z or vX.Y.Z-<pre-release> tag's version, +N.g<commit> when N commits past it, and dirty with uncommitted changes.

set -euo pipefail
shopt -s inherit_errexit

REPOSITORY="${1:-.}"
RELEASE_TAG_PATTERN='v[0-9]*.[0-9]*.[0-9]*'
UNTAGGED_VERSION=0.0.0
COMMIT_ID_LENGTH=7

require_full_history() {
  if ! git -C "$REPOSITORY" rev-parse --git-dir >/dev/null 2>&1; then
    echo "$REPOSITORY is not a git repository, so it has no product version." >&2
    exit 1
  fi
  if [ "$(git -C "$REPOSITORY" rev-parse --is-shallow-repository)" = true ]; then
    echo "$REPOSITORY is a shallow clone, which hides tags and commit counts; fetch with full history." >&2
    exit 1
  fi
}

describe_from_tag() {
  git -C "$REPOSITORY" describe --tags --match "$RELEASE_TAG_PATTERN" --abbrev="$COMMIT_ID_LENGTH" --long 2>/dev/null
}

describe_without_tag() {
  local commit_count commit
  commit_count="$(git -C "$REPOSITORY" rev-list --count HEAD)"
  commit="$(git -C "$REPOSITORY" rev-parse --short="$COMMIT_ID_LENGTH" HEAD)"
  echo "v$UNTAGGED_VERSION-$commit_count-g$commit"
}

# Splits describe's v<version>-<commits past>-g<commit> on its last two dashes, as a pre-release has dashes of its own.
format_version() {
  local description="$1"
  local commit="${description##*-}"
  local tag_and_commits_past="${description%-*}"
  local commits_past="${tag_and_commits_past##*-}"
  local tagged_version="${tag_and_commits_past%-*}"
  tagged_version="${tagged_version#v}"
  if [ "$commits_past" = 0 ]; then
    echo "$tagged_version"
  else
    echo "$tagged_version+$commits_past.$commit"
  fi
}

mark_if_dirty() {
  local version="$1"
  if [ -z "$(git -C "$REPOSITORY" status --porcelain)" ]; then
    echo "$version"
  elif [[ "$version" == *+* ]]; then
    echo "$version.dirty"
  else
    echo "$version+dirty"
  fi
}

require_full_history
description="$(describe_from_tag)" || description="$(describe_without_tag)"
mark_if_dirty "$(format_version "$description")"
