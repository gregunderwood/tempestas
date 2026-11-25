#!/usr/bin/env bash
# tools/pr-video.sh <pr> [spec...]                 records the stack specs and posts them on the PR
# tools/pr-video.sh --player-url <url> <pr>        links the published player page from that comment
# When and how to use it: docs/Testing.md.

set -euo pipefail

readonly USAGE="Usage: tools/pr-video.sh <pr> [spec...]   or   tools/pr-video.sh --player-url <url> <pr>"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TOOL_NAME="pr-video"
readonly COMMENT_MARKER="<!-- pr-video -->"
readonly PLAYER_LINK_PLACEHOLDER="<!-- player-link -->"
readonly VIDEOS_FOLDER="$REPO_ROOT/dist/cypress/apps/web-e2e/stack/videos"
readonly PLAYER_TEMPLATE="$REPO_ROOT/tools/pr-video/player.html"
readonly RECORDINGS_SCRIPT="$REPO_ROOT/tools/pr-video/recordings.mjs"
readonly GIF_FILTER="fps=8,scale=960:-1:flags=lanczos,split[frames][copy];[frames]palettegen=max_colors=128[palette];[copy][palette]paletteuse=dither=bayer"

source "$REPO_ROOT/tools/lib/console.sh"
source "$REPO_ROOT/tools/lib/failure.sh"
source "$REPO_ROOT/tools/lib/pull-request-media.sh"

PULL_REQUEST=""
SPECS=()
PLAYER_URL=""
WORK_DIR=""
PLAYER_FOLDER=""

main() {
  parse_arguments "$@"
  cd "$REPO_ROOT"
  if [[ -n "$PLAYER_URL" ]]; then
    link_player
    return
  fi
  require_pull_request_checked_out
  WORK_DIR="$(mktemp -d -t pr-video.XXXXXX)"
  trap tear_down EXIT

  record_stack_specs
  convert_videos_to_gifs
  write_player
  publish_media "chore: videos for #$PULL_REQUEST" "$VIDEOS_FOLDER"/*.mp4 "$VIDEOS_FOLDER"/*.gif
  post_video_comment
  explain_player_step
}

parse_arguments() {
  if [[ "${1:-}" == "--player-url" ]]; then
    [[ $# -eq 3 && "$3" =~ ^[0-9]+$ ]] || usage_error
    PLAYER_URL="$2"
    PULL_REQUEST="$3"
    return
  fi
  [[ $# -ge 1 && "$1" =~ ^[0-9]+$ ]] || usage_error
  PULL_REQUEST="$1"
  shift
  SPECS=("$@")
}

usage_error() {
  echo "$USAGE" >&2
  exit 2
}

# Cleared first, so a spec left out of this run cannot be posted from an older one.
record_stack_specs() {
  say "Recording the stack specs"
  rm -rf "$VIDEOS_FOLDER"
  local spec_option=()
  if [[ ${#SPECS[@]} -gt 0 ]]; then
    spec_option=(--spec "$(IFS=,; echo "${SPECS[*]}")")
  fi
  "$REPO_ROOT/tools/e2e-stack.sh" --config video=true "${spec_option[@]}" >"$WORK_DIR/stack.log" 2>&1 ||
    fail_with_log "the stack specs failed, so there is nothing worth posting" stack.log
}

convert_videos_to_gifs() {
  say "Converting the videos to GIFs"
  local ffmpeg video
  ffmpeg="$(find_ffmpeg)"
  for video in "$VIDEOS_FOLDER"/*.mp4; do
    "$ffmpeg" -v error -y -i "$video" -vf "$GIF_FILTER" "${video%.mp4}.gif"
    echo "  $(basename "${video%.mp4}.gif")"
  done
}

# Cypress ships its own ffmpeg to record with, so nothing else needs installing.
find_ffmpeg() {
  local cypress_ffmpeg
  cypress_ffmpeg="$(npx cypress cache path)/$(npx cypress version --component package)/Cypress/resources/app/node_modules/@ffmpeg-installer/linux-x64/ffmpeg"
  if [[ -x "$cypress_ffmpeg" ]]; then
    echo "$cypress_ffmpeg"
  elif command -v ffmpeg >/dev/null; then
    command -v ffmpeg
  else
    fail "found no ffmpeg, neither Cypress's at $cypress_ffmpeg nor one on the PATH"
  fi
}

# Kept in dist, not the work folder, because it is published as an artifact after this script ends.
write_player() {
  PLAYER_FOLDER="$REPO_ROOT/dist/pr-video/$PULL_REQUEST"
  say "Writing the player page to $PLAYER_FOLDER"
  rm -rf "$PLAYER_FOLDER"
  mkdir -p "$PLAYER_FOLDER"
  # Named for the PR, so each player is told apart in the artifact list.
  sed "s|<title>PR Video Player</title>|<title>PR #$PULL_REQUEST Video</title>|" "$PLAYER_TEMPLATE" >"$PLAYER_FOLDER/index.html"
  node "$RECORDINGS_SCRIPT" player "$VIDEOS_FOLDER" "$PLAYER_FOLDER" "$PULL_REQUEST" "${HEAD_SHA:0:7}"
}

post_video_comment() {
  say "Posting the video on PR #$PULL_REQUEST"
  node "$RECORDINGS_SCRIPT" comment "$PLAYER_FOLDER" "$(media_url_base blob)" "$(media_url_base raw)" "$COMMENT_MARKER" \
    >"$WORK_DIR/comment.md"
  post_marked_comment "$COMMENT_MARKER" "$WORK_DIR/comment.md"
}

explain_player_step() {
  say "Next: publish the player, then link it"
  echo "  Publish $PLAYER_FOLDER/index.html as an artifact, with videos.json and the mp4s beside it,"
  echo "  then run: tools/pr-video.sh --player-url <its url> $PULL_REQUEST"
}

link_player() {
  say "Linking the player from the video comment on PR #$PULL_REQUEST"
  local comment_id
  comment_id="$(find_marked_comment "$COMMENT_MARKER")"
  [[ -n "$comment_id" ]] || fail "PR #$PULL_REQUEST has no video comment yet. Run tools/pr-video.sh $PULL_REQUEST first."
  WORK_DIR="$(mktemp -d -t pr-video.XXXXXX)"
  trap tear_down EXIT
  gh api "repos/{owner}/{repo}/issues/comments/$comment_id" --jq .body |
    PLAYER_LINE="**[Watch in the player]($PLAYER_URL)**, with speed from 0.25× to 2×, frame stepping, and a jump to each step." \
      PLACEHOLDER="$PLAYER_LINK_PLACEHOLDER" \
      node -e 'let body = ""; process.stdin.on("data", (chunk) => (body += chunk)).on("end", () =>
        process.stdout.write(body.replaceAll(process.env.PLACEHOLDER, process.env.PLAYER_LINE)));' \
      >"$WORK_DIR/comment.md"
  post_marked_comment "$COMMENT_MARKER" "$WORK_DIR/comment.md"
}

tear_down() {
  local exit_status=$?
  remove_worktree "$MEDIA_CHECKOUT"
  rm -rf "$WORK_DIR"
  exit "$exit_status"
}

main "$@"
