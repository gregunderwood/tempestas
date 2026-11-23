# Sourced by tools/deploy.sh after each agent's agent-files.sh and tools/lib/release.sh; see docs/Infrastructure/Deploys.md.

AGENT_APPS=(agent-linux agent-micropython)
AGENT_RELEASES_DIRECTORY=agent-releases
BUNDLE_FILES_DIRECTORY=files
BUNDLE_MANIFEST=manifest.json
KEPT_AGENT_RELEASES=2
RELEASED_AGENT_VERSION='^[0-9]+\.[0-9]+\.[0-9]+$'
DEVELOPMENT_RELEASE_SUFFIX='-dev(-dirty)?$'

# The whole checkout must be clean, as the bundle also depends on files outside the agent's own directory.
build_agent_bundles() {
  local repository="$1" release_id="$2" output_root="$3"
  local app
  if ! rm -rf "$output_root"; then
    echo "Could not clear $output_root, so no agent is bundled; the server deploy goes on without them." >&2
    return
  fi
  if [[ "$release_id" =~ $DEVELOPMENT_RELEASE_SUFFIX ]]; then
    echo "$release_id is not a clean origin/main build, so no agent is bundled." >&2
    return
  fi
  for app in "${AGENT_APPS[@]}"; do
    build_agent_bundle "$repository" "$app" "$output_root"
  done
}

# Only a clean origin/main build: a -dev one is never offered to a node.
build_agent_bundle() {
  local repository="$1" app="$2" output_root="$3"
  local version bundle_dir
  if ! version="$("$repository/tools/describe-agent-version.sh" "$repository/apps/$app")"; then
    echo "$app has no version to bundle under; the server deploy goes on without it." >&2
    return
  fi
  if ! [[ "$version" =~ $RELEASED_AGENT_VERSION ]]; then
    echo "$app $version is not a clean origin/main build, so it is not bundled." >&2
    return
  fi
  bundle_dir="$output_root/$app/$version"
  if ! mkdir -p "$bundle_dir/$BUNDLE_FILES_DIRECTORY" ||
    ! copy_agent_files "$repository" "$app" "$bundle_dir/$BUNDLE_FILES_DIRECTORY" "$version" ||
    ! write_bundle_manifest "$bundle_dir" "$app" "$version"; then
    rm -rf "$bundle_dir" || true
    echo "$app $version is not bundled; the server deploy goes on without it." >&2
    return
  fi
  echo "Bundled $app $version"
}

# Tracked files only, so a stray __pycache__ or a credentials.py never ships. Every step is checked: callers test it with `if`.
copy_agent_files() {
  local repository="$1" app="$2" files_dir="$3" version="$4"
  local source_dir stamp file_list copy_status
  local wanted_paths=()
  case "$app" in
    agent-linux)
      source_dir="$repository/apps/agent-linux"
      stamp="$LINUX_AGENT_VERSION_STAMP"
      wanted_paths=("${LINUX_AGENT_PATHS[@]}")
      ;;
    agent-micropython)
      source_dir="$repository/apps/agent-micropython/device"
      stamp="$MICROPYTHON_AGENT_VERSION_STAMP"
      wanted_paths=("${MICROPYTHON_AGENT_CODE[@]}" "$MICROPYTHON_BOARDS_DIRECTORY")
      ;;
  esac
  file_list="$(mktemp)"
  # NUL-separated, as git quotes a name holding anything unusual in its line output.
  git -C "$source_dir" ls-files -z -- "${wanted_paths[@]}" >"$file_list" &&
    require_every_path_tracked "$app" "$file_list" "${wanted_paths[@]}" &&
    rsync -a --from0 --files-from="$file_list" "$source_dir/" "$files_dir/" &&
    mkdir -p "$(dirname "$files_dir/$stamp")" &&
    printf 'AGENT_VERSION = "%s"\n' "$version" >"$files_dir/$stamp"
  copy_status=$?
  rm -f "$file_list"
  return "$copy_status"
}

# git ls-files skips a name it does not know, so a file renamed without updating its agent-files.sh would vanish unnoticed.
require_every_path_tracked() {
  local app="$1" file_list="$2"
  shift 2
  local wanted_path tracked_path
  local tracked_paths=() missing_paths=()
  mapfile -d '' tracked_paths <"$file_list"
  for wanted_path in "$@"; do
    for tracked_path in "${tracked_paths[@]}"; do
      [[ "$tracked_path" == "$wanted_path" || "$tracked_path" == "$wanted_path"/* ]] && continue 2
    done
    missing_paths+=("$wanted_path")
  done
  if [ "${#missing_paths[@]}" -gt 0 ]; then
    echo "apps/$app/agent-files.sh lists ${missing_paths[*]}, but git tracks no such file." >&2
    return 1
  fi
}

# Hashed in node rather than parsed from sha256sum, which escapes a file name holding a backslash.
write_bundle_manifest() {
  local bundle_dir="$1" app="$2" version="$3"
  node -e '
    const { createHash } = require("node:crypto");
    const { readdirSync, readFileSync, statSync } = require("node:fs");
    const { join } = require("node:path");
    const [filesDirectory, app, version] = process.argv.slice(1);
    const [contractMajor, contractMinor] = version.split(".").map(Number);
    const files = readdirSync(filesDirectory, { recursive: true })
      .filter((path) => statSync(join(filesDirectory, path)).isFile())
      .sort()
      .map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(join(filesDirectory, path))).digest("hex") }));
    process.stdout.write(JSON.stringify({ app, version, contractMajor, contractMinor, files }, null, 2) + "\n");
  ' "$bundle_dir/$BUNDLE_FILES_DIRECTORY" "$app" "$version" >"$bundle_dir/$BUNDLE_MANIFEST"
}

# A version already on the host is never shipped over. A failed ship leaves only a dot-name, which the server skips and prune clears.
ship_agent_bundles() {
  local host="$1" output_root="$2"
  local bundle_dir app version remote_app_dir
  for bundle_dir in "$output_root"/*/*; do
    [ -d "$bundle_dir" ] || continue
    app="$(basename "$(dirname "$bundle_dir")")"
    version="$(basename "$bundle_dir")"
    remote_app_dir="$REMOTE_ROOT/$AGENT_RELEASES_DIRECTORY/$app"
    if ssh "$host" "test -e $remote_app_dir/$version"; then
      report_bundle_already_shipped "$host" "$bundle_dir" "$remote_app_dir/$version" "$app" "$version"
    elif ship_agent_bundle "$host" "$bundle_dir" "$remote_app_dir" "$version"; then
      echo "Shipped $app $version"
    else
      echo "Could not ship $app $version to $host; the server deploy goes on without it." >&2
    fi
  done
}

ship_agent_bundle() {
  local host="$1" bundle_dir="$2" remote_app_dir="$3" version="$4"
  ssh "$host" "mkdir -p $remote_app_dir && rm -rf $remote_app_dir/.$version" &&
    rsync -a "$bundle_dir/" "$host:$remote_app_dir/.$version/" &&
    ssh "$host" "mv -T $remote_app_dir/.$version $remote_app_dir/$version"
}

report_bundle_already_shipped() {
  local host="$1" bundle_dir="$2" remote_bundle_dir="$3" app="$4" version="$5"
  if list_bundle_checksums "$bundle_dir" | ssh "$host" "cd $remote_bundle_dir && sha256sum --status --strict -c -"; then
    echo "$host already has $app $version"
    return
  fi
  echo "$host has an $app $version that differs from the one just built, and it is kept. To ship this one, run: ssh $host rm -rf $remote_bundle_dir, then deploy again." >&2
}

list_bundle_checksums() {
  local bundle_dir="$1"
  (cd "$bundle_dir" && sha256sum "$BUNDLE_MANIFEST" && find "$BUNDLE_FILES_DIRECTORY" -type f | LC_ALL=C sort | xargs -d '\n' sha256sum)
}

# The newest few versions of each agent on each contract major, as a node is offered only its own major; no unfinished ship.
prune_agent_bundles() {
  local host="$1"
  ssh "$host" bash -s -- "$REMOTE_ROOT/$AGENT_RELEASES_DIRECTORY" "$KEPT_AGENT_RELEASES" "$RELEASED_AGENT_VERSION" <<'REMOTE'
set -euo pipefail
root="$1" kept_releases="$2" released_version="$3"
[ -d "$root" ] || exit 0
for app_dir in "$root"/*/; do
  [ -d "$app_dir" ] || continue
  # Only a deploy ships, and this one already has, so a dot-name left now is an abandoned ship.
  find "$app_dir" -mindepth 1 -maxdepth 1 -name '.*' -exec rm -rf -- {} +
  versions="$({ ls -1 "$app_dir" | grep -E "$released_version" || true; })"
  for contract_major in $(cut -d. -f1 <<<"$versions" | sort -u); do
    { grep "^$contract_major\." <<<"$versions" || true; } | sort -V | head -n "-$kept_releases" |
      while read -r version; do rm -rf -- "$app_dir$version"; done
  done
done
REMOTE
}
