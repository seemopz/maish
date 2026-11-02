#! /usr/bin/env bash
# Stands in for the GTK plugin that `tauri build` hands to linuxdeploy. Runs the
# upstream plugin unchanged, then removes the libraries that must come from the
# host (see verify-appimage-libs.mjs for why). This is the last step before
# linuxdeploy packs the AppDir, so the AppImage tauri signs and uploads is
# already free of them.
#
# Tauri downloads its linuxdeploy tools into ~/.cache/tauri only when they are
# missing, so the release workflow installs this file there under the upstream
# name and the upstream plugin next to it as upstream/linuxdeploy-plugin-gtk.sh
# (a subdirectory, so linuxdeploy does not discover it as a second plugin).
#
# Neither linuxdeploy nor tauri offer a way to exclude a library: tauri passes
# no options through, and linuxdeploy ignores LINUXDEPLOY_EXCLUDED_LIBRARIES.
set -euo pipefail

upstream="$(dirname "$(readlink -f "$0")")/upstream/linuxdeploy-plugin-gtk.sh"
"$upstream" "$@"

# Same argument form the upstream plugin accepts: --appdir <path>.
appdir=""
while [ $# -gt 0 ]; do
    case "$1" in
        --appdir) appdir="${2:-}"; shift ;;
    esac
    shift
done
# --plugin-api-version, --help: nothing was deployed.
[ -n "$appdir" ] || exit 0

shopt -s nullglob
for lib in "$appdir"/usr/lib/libwayland-*.so*; do
    echo "Removing $lib, it must come from the host"
    rm -f "$lib"
done
