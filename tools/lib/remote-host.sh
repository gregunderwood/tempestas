# Sourced by the deploy scripts: checks on a host that need neither a password nor a guess.

LINUX_HOSTS=(elantris patji)
EXIT_HOST_UNREACHABLE=255

# Exits unless sudo would run every `systemctl ...` line as root WITHOUT a password; `sudo -l <cmd>` alone passes a password rule too.
require_passwordless_systemctl() {
  local host="$1"
  shift
  local status=0
  ssh "$host" "bash -s -- $(printf '%q ' "$@")" <<'REMOTE' || status=$?
systemctl_path="$(command -v systemctl)"
# One rule per line, as sudo lists them in sudoers order.
rules="$(sudo -n -l 2>/dev/null | tr '\n' ' ' | tr -s ' ' | sed 's/ (/\n(/g' | grep '^(')"

# Like sudo: the last rule naming the command (or ALL) decides, and a tag holds until the next one.
read_password_tag() {
  awk -v wanted="$1" '
    {
      is_root_runas = ($0 ~ /^\((root|ALL)[ :)]/)
      tag = "PASSWD"
      commands = substr($0, index($0, ")") + 1)
      item_count = split(commands, items, ",")
      for (item_index = 1; item_index <= item_count; item_index++) {
        item = items[item_index]
        while (match(item, /^ *[A-Z_]+: */)) {
          name = substr(item, RSTART, RLENGTH)
          gsub(/[ :]/, "", name)
          if (name == "NOPASSWD" || name == "PASSWD") tag = name
          item = substr(item, RSTART + RLENGTH)
        }
        gsub(/^ +| +$/, "", item)
        if (is_root_runas && (item == wanted || item == "ALL")) verdict = tag
      }
    }
    END { print verdict }
  ' <<<"$rules"
}

is_any_line_missing=false
for command in "$@"; do
  if [ "$(read_password_tag "$systemctl_path $command")" != NOPASSWD ]; then
    echo "  sudo $systemctl_path $command" >&2
    is_any_line_missing=true
  fi
done
! "$is_any_line_missing"
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
