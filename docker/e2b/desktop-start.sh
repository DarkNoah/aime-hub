#!/bin/bash
# Runs inside the desktop microVM as user, before E2B snapshots the template.
set -Eeuo pipefail
export DISPLAY=:0
export XDG_RUNTIME_DIR=/tmp/desktop-runtime
umask 077
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# The image includes a panel power plugin, but these VMs do not run UPower.
panel="$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
if [[ ! -f "$panel" ]]; then
  mkdir -p "$(dirname "$panel")"
  sed '/<value type="int" value="9"/d; /value="power-manager-plugin"/d' \
    /etc/xdg/xfce4/panel/default.xml > "$panel"
fi

pids=()
cleanup() {
  trap - EXIT
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
Xvfb "$DISPLAY" -screen 0 1280x720x24 -ac -nolisten tcp &
pids+=("$!")
for ((attempt = 0; attempt < 60; attempt++)); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  kill -0 "${pids[0]}" 2>/dev/null || exit 1
  sleep 0.5
done
xdpyinfo -display "$DISPLAY" >/dev/null
xset s off
dbus-run-session -- startxfce4 &
pids+=("$!")
wait -n "${pids[@]}" || true
exit 1
