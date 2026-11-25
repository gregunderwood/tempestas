#!/usr/bin/env bash
# tools/build-agent-deb.sh [output directory]
# Builds tempestas-agent_<version>_all.deb from this checkout; see docs/Infrastructure/Packages.md.

set -euo pipefail
shopt -s inherit_errexit

HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIRECTORY="${1:-$HERE/dist/packages}"
AGENT_DIRECTORY="$HERE/apps/agent-linux"
PACKAGING_DIRECTORY="$AGENT_DIRECTORY/packaging"
PACKAGE_NAME=tempestas-agent
INSTALL_DIRECTORY=usr/lib/tempestas/agent
UNIT_DIRECTORY=usr/lib/systemd/system
DOCUMENT_DIRECTORY="usr/share/doc/$PACKAGE_NAME"
MAINTAINER_SCRIPTS=(postinst prerm postrm)
OLDEST_SUPPORTED_PYTHON=3.11

source "$HERE/tools/lib/debian-version.sh"

copy_agent_code() {
  local package_root="$1" agent_version="$2"
  mkdir -p "$package_root/$INSTALL_DIRECTORY"
  cp -r "$AGENT_DIRECTORY/src/tempestas_agent" "$AGENT_DIRECTORY/tools" "$package_root/$INSTALL_DIRECTORY/"
  find "$package_root/$INSTALL_DIRECTORY" -name __pycache__ -prune -exec rm -r {} +
  printf 'AGENT_VERSION = "%s"\nINSTALLED_FROM_A_PACKAGE = True\n' "$agent_version" \
    >"$package_root/$INSTALL_DIRECTORY/tempestas_agent/deployed_version.py"
}

# Pure-Python wheels only, so one package serves every Pi and bookworm's too-old paho never loads.
vendor_dependencies() {
  local package_root="$1" requirements="$2"
  local vendor_directory="$package_root/$INSTALL_DIRECTORY/vendor"
  uv export --directory "$AGENT_DIRECTORY" --frozen --no-dev --no-emit-project --quiet --output-file "$requirements"
  uv pip install --quiet --no-deps --only-binary :all: --python-version "$OLDEST_SUPPORTED_PYTHON" \
    --target "$vendor_directory" --requirement "$requirements"
  rm -rf "${vendor_directory:?}/bin" "${vendor_directory:?}/.lock"
  if find "$vendor_directory" -name '*.so*' | grep -q .; then
    echo "A vendored dependency is compiled, so the package can no longer be Architecture: all:" >&2
    find "$vendor_directory" -name '*.so*' >&2
    exit 1
  fi
}

copy_unit_and_example_config() {
  local package_root="$1"
  mkdir -p "$package_root/$UNIT_DIRECTORY" "$package_root/$DOCUMENT_DIRECTORY"
  cp "$PACKAGING_DIRECTORY/tempestas-agent.service" "$package_root/$UNIT_DIRECTORY/"
  cp "$AGENT_DIRECTORY/agent.example.toml" "$package_root/$DOCUMENT_DIRECTORY/"
}

write_control() {
  local package_root="$1" debian_version="$2"
  local installed_kilobytes
  mkdir -p "$package_root/DEBIAN"
  installed_kilobytes="$(du -sk --exclude=DEBIAN "$package_root" | cut -f1)"
  cat >"$package_root/DEBIAN/control" <<CONTROL
Package: $PACKAGE_NAME
Version: $debian_version
Architecture: all
Maintainer: tempestas <packages@tempestas.invalid>
Installed-Size: $installed_kilobytes
Depends: python3 (>= $OLDEST_SUPPORTED_PYTHON), passwd
Recommends: python3-lgpio
Section: misc
Priority: optional
Homepage: https://github.com/gregunderwood/tempestas
Description: tempestas node agent
 Reads a node's sensors and drives its relay lines for a tempestas server,
 over MQTT. It claims no relay line until /etc/tempestas/agent.toml names one.
CONTROL
  for script in "${MAINTAINER_SCRIPTS[@]}"; do
    install -m 0755 "$PACKAGING_DIRECTORY/$script" "$package_root/DEBIAN/$script"
  done
}

# The checkout's modes depend on the umask; a package's must not.
normalise_modes() {
  local package_root="$1"
  find "$package_root" -path "$package_root/DEBIAN" -prune -o -type d -exec chmod 0755 {} +
  find "$package_root" -path "$package_root/DEBIAN" -prune -o -type f -exec chmod 0644 {} +
}

AGENT_VERSION="$("$HERE/tools/describe-agent-version.sh" "$AGENT_DIRECTORY")"
DEBIAN_VERSION="$(to_debian_version "$AGENT_VERSION")"
STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING:?}"' EXIT
PACKAGE_ROOT="$STAGING/root"

copy_agent_code "$PACKAGE_ROOT" "$AGENT_VERSION"
vendor_dependencies "$PACKAGE_ROOT" "$STAGING/requirements.txt"
copy_unit_and_example_config "$PACKAGE_ROOT"
normalise_modes "$PACKAGE_ROOT"
write_control "$PACKAGE_ROOT" "$DEBIAN_VERSION"

mkdir -p "$OUTPUT_DIRECTORY"
PACKAGE_FILE="$OUTPUT_DIRECTORY/${PACKAGE_NAME}_${DEBIAN_VERSION}_all.deb"
dpkg-deb --root-owner-group --build "$PACKAGE_ROOT" "$PACKAGE_FILE" >/dev/null
echo "$PACKAGE_FILE"
