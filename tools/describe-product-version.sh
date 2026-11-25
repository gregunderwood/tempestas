#!/usr/bin/env bash
# tools/describe-product-version.sh [repository]
# Prints the highest reachable vX.Y.Z or vX.Y.Z-<pre-release> tag's version, +N.g<commit> when N commits past it, and dirty with uncommitted changes.

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

# The highest version reachable, not the nearest tag; versionsort.suffix puts 1.4.0-dev.1 below 1.4.0.
find_highest_release_tag() {
  git -C "$REPOSITORY" -c versionsort.suffix=- tag --merged HEAD --list "$RELEASE_TAG_PATTERN" --sort=-v:refname |
    head -n 1
}

describe_version() {
  local tag="$1" tagged_version commits_past commit
  if [ -z "$tag" ]; then
    tagged_version="$UNTAGGED_VERSION"
    commits_past="$(git -C "$REPOSITORY" rev-list --count HEAD)"
  else
    tagged_version="${tag#v}"
    commits_past="$(git -C "$REPOSITORY" rev-list --count "$tag..HEAD")"
  fi
  commit="$(git -C "$REPOSITORY" rev-parse --short="$COMMIT_ID_LENGTH" HEAD)"
  if [ "$commits_past" = 0 ] && [ -n "$tag" ]; then
    echo "$tagged_version"
  else
    echo "$tagged_version+$commits_past.g$commit"
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
# Assigned one at a time, as a failure inside a command's argument would not stop the script.
TAG="$(find_highest_release_tag)"
VERSION="$(describe_version "$TAG")"
mark_if_dirty "$VERSION"
