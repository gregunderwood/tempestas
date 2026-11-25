# Sourced by the package builds; turns an agent or product version into a Debian one.

# Debian upstream versions without a revision: a digit first, then letters, digits and . + ~ only.
DEBIAN_VERSION_PATTERN='^[0-9][A-Za-z0-9.+~]*$'

# A pre-release's - becomes ~, the one character dpkg sorts below nothing at all: 1.4.0~dev.1 < 1.4.0.
to_debian_version() {
  local version="$1"
  local debian_version="${version//-/\~}"
  if ! [[ "$debian_version" =~ $DEBIAN_VERSION_PATTERN ]]; then
    echo "$version cannot be a Debian version: it needs a digit first, then only letters, digits, '.', '+', '~' or '-'." >&2
    return 1
  fi
  echo "$debian_version"
}
