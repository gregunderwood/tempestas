# Sourced by the deploy scripts: checks on a host that need neither a password nor a guess.

EXIT_HOST_UNREACHABLE=255

# Exits unless every `systemctl ...` line is allowed WITHOUT a password; `sudo -l <cmd>` alone also passes a password-only rule.
require_passwordless_systemctl() {
  local host="$1"
  shift
  local status=0
  ssh "$host" "bash -s -- $(printf '%q ' "$@")" <<'REMOTE' || status=$?
systemctl_path="$(command -v systemctl)"
passwordless_entries="$(sudo -n -l 2>/dev/null | tr '\n' ' ' | tr -s ' ' | sed 's/ (/\n(/g' | grep 'NOPASSWD:' | sed 's/ *$/,/')"
if grep -qF 'NOPASSWD: ALL,' <<<"$passwordless_entries"; then
  exit 0
fi
missing=0
for command in "$@"; do
  if ! grep -qF " $systemctl_path $command," <<<"$passwordless_entries"; then
    echo "  sudo $systemctl_path $command" >&2
    missing=1
  fi
done
exit "$missing"
REMOTE
  if [ "$status" -eq "$EXIT_HOST_UNREACHABLE" ]; then
    echo "Could not reach $host over ssh." >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "$host asks for a password for the lines above. Run tools/install-deploy-privileges.sh $host." >&2
    exit 1
  fi
}
