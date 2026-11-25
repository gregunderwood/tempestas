#!/usr/bin/env bash
# tools/describe-product-version.sh [repository]
# Prints X.Y.Z at a vX.Y.Z tag, X.Y.Z+N.g<commit> N commits past it, and 0.0.0+N.g<commit> before the first tag.

set -euo pipefail

REPOSITORY="${1:-.}"
RELEASE_TAG_PATTERN='v[0-9]*.[0-9]*.[0-9]*'
UNTAGGED_VERSION=0.0.0
COMMIT_ID_LENGTH=7

describe_from_tag() {
  git -C "$REPOSITORY" describe --tags --match "$RELEASE_TAG_PATTERN" --abbrev="$COMMIT_ID_LENGTH" --long 2>/dev/null
}

describe_without_tag() {
  local commit_count commit
  commit_count="$(git -C "$REPOSITORY" rev-list --count HEAD)"
  commit="$(git -C "$REPOSITORY" rev-parse --short="$COMMIT_ID_LENGTH" HEAD)"
  echo "v$UNTAGGED_VERSION-$commit_count-g$commit"
}

# Splits describe's v<version>-<commits past>-g<commit> on its last two dashes.
format_version() {
  local description="$1"
  local commit="${description##*-}"
  local rest="${description%-*}"
  local commits_past="${rest##*-}"
  local tagged_version="${rest%-*}"
  tagged_version="${tagged_version#v}"
  if [ "$commits_past" = 0 ]; then
    echo "$tagged_version"
  else
    echo "$tagged_version+$commits_past.$commit"
  fi
}

has_uncommitted_changes() {
  [ -n "$(git -C "$REPOSITORY" status --porcelain)" ]
}

VERSION="$(format_version "$(describe_from_tag || describe_without_tag)")"
if has_uncommitted_changes; then
  case "$VERSION" in
    *+*) VERSION="$VERSION.dirty" ;;
    *) VERSION="$VERSION+dirty" ;;
  esac
fi
echo "$VERSION"
