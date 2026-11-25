# Sourced by the dev tools that build on tools/lib/fake-stack.sh; the caller sets TOOL_NAME and WORK_DIR.

fail() {
  echo "$TOOL_NAME: $1" >&2
  exit 1
}

fail_with_log() {
  local reason=$1 log_name=$2
  echo "$TOOL_NAME: $reason. The end of $log_name:" >&2
  tail -n 30 "$WORK_DIR/$log_name" >&2 || true
  exit 1
}
