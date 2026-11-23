# Sourced by tools/deploy.sh: a release bundle per agent for the server to offer; see docs/Infrastructure/Deploys.md.
# Needs tools/lib/agent-files.sh, and REMOTE_ROOT from tools/lib/release.sh.

AGENT_APPS=(agent-linux agent-micropython)
AGENT_RELEASES_DIRECTORY=agent-releases
BUNDLE_FILES_DIRECTORY=files
BUNDLE_MANIFEST=manifest.json
KEPT_AGENT_RELEASES=2
RELEASED_AGENT_VERSION='^[0-9]+\.[0-9]+\.[0-9]+$'

# Only a clean origin/main build: a -dev one is never offered to a node.
build_agent_bundle() {
  local repository="$1" app="$2" output_root="$3"
  local version bundle_dir
  version="$("$repository/tools/describe-agent-version.sh" "$repository/apps/$app")"
  if ! [[ "$version" =~ $RELEASED_AGENT_VERSION ]]; then
    echo "$app $version is not a clean origin/main build, so it is not bundled." >&2
    return
  fi
  bundle_dir="$output_root/$app/$version"
  mkdir -p "$bundle_dir/$BUNDLE_FILES_DIRECTORY"
  copy_agent_files "$repository" "$app" "$bundle_dir/$BUNDLE_FILES_DIRECTORY" "$version"
  write_bundle_manifest "$bundle_dir" "$app" "$version"
  echo "Bundled $app $version"
}

# Tracked files only, so a stray __pycache__ or a credentials.py never ships.
copy_agent_files() {
  local repository="$1" app="$2" files_dir="$3" version="$4"
  local source_dir stamp file_list
  file_list="$(mktemp)"
  case "$app" in
    agent-linux)
      source_dir="$repository/apps/agent-linux"
      stamp="$LINUX_AGENT_VERSION_STAMP"
      git -C "$source_dir" ls-files -- "${LINUX_AGENT_PATHS[@]}" >"$file_list"
      ;;
    agent-micropython)
      source_dir="$repository/apps/agent-micropython/device"
      stamp="$MICROPYTHON_AGENT_VERSION_STAMP"
      git -C "$source_dir" ls-files -- "${MICROPYTHON_AGENT_CODE[@]}" "$MICROPYTHON_BOARDS_DIRECTORY" >"$file_list"
      ;;
  esac
  rsync -a --files-from="$file_list" "$source_dir/" "$files_dir/"
  rm "$file_list"
  mkdir -p "$(dirname "$files_dir/$stamp")"
  printf 'AGENT_VERSION = "%s"\n' "$version" >"$files_dir/$stamp"
}

write_bundle_manifest() {
  local bundle_dir="$1" app="$2" version="$3"
  (cd "$bundle_dir/$BUNDLE_FILES_DIRECTORY" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | xargs -d '\n' sha256sum) |
    node -e '
      const [app, version] = process.argv.slice(1);
      const [contractMajor, contractMinor] = version.split(".").map(Number);
      const files = require("node:fs").readFileSync(0, "utf8").trim().split("\n").map((line) => {
        const separator = line.indexOf("  ");
        return { path: line.slice(separator + 2), sha256: line.slice(0, separator) };
      });
      process.stdout.write(JSON.stringify({ app, version, contractMajor, contractMinor, files }, null, 2) + "\n");
    ' "$app" "$version" >"$bundle_dir/$BUNDLE_MANIFEST"
}

# A version already on the host is never shipped over; a new one lands under a dot-name the server skips, then is renamed.
ship_agent_bundles() {
  local host="$1" output_root="$2"
  local bundle_dir app version remote_app_dir
  for bundle_dir in "$output_root"/*/*; do
    [ -d "$bundle_dir" ] || continue
    app="$(basename "$(dirname "$bundle_dir")")"
    version="$(basename "$bundle_dir")"
    remote_app_dir="$REMOTE_ROOT/$AGENT_RELEASES_DIRECTORY/$app"
    if ssh "$host" "test -e $remote_app_dir/$version"; then
      echo "$host already has $app $version"
      continue
    fi
    ssh "$host" "mkdir -p $remote_app_dir && rm -rf $remote_app_dir/.$version"
    rsync -a "$bundle_dir/" "$host:$remote_app_dir/.$version/"
    ssh "$host" "mv -T $remote_app_dir/.$version $remote_app_dir/$version"
    echo "Shipped $app $version"
  done
}

# The newest few versions of each agent; whatever else is in the directory stays.
prune_agent_bundles() {
  local host="$1"
  ssh "$host" bash -s -- "$REMOTE_ROOT/$AGENT_RELEASES_DIRECTORY" "$KEPT_AGENT_RELEASES" "$RELEASED_AGENT_VERSION" <<'REMOTE'
set -euo pipefail
root="$1" kept_releases="$2" released_version="$3"
[ -d "$root" ] || exit 0
for app_dir in "$root"/*/; do
  [ -d "$app_dir" ] || continue
  { ls -1 "$app_dir" | grep -E "$released_version" || true; } | sort -V | head -n "-$kept_releases" |
    while read -r version; do rm -rf -- "$app_dir$version"; done
done
REMOTE
}
