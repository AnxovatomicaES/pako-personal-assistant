# Sourced by build.sh and sign.sh. syncedFolder <path>: true when the path (or the folder it would be made in) is inside a File Provider
# domain (iCloud Drive, Desktop and Documents in iCloud, a cloud storage app): its root folder carries com.apple.file-provider-domain-id.
syncedFolder() {
  d=$1
  while [ -n "$d" ] && [ ! -d "$d" ]; do d=$(dirname "$d"); done
  d=$(cd "${d:-/}" && pwd -P) || return 1
  while :; do
    if xattr "$d" 2>/dev/null | grep -qx 'com.apple.file-provider-domain-id'; then return 0; fi
    [ "$d" = / ] && return 1
    d=$(dirname "$d")
  done
}
