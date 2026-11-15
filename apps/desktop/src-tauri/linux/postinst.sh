#!/bin/sh
set -e
# Load the bundled browser's AppArmor profile now, so motion graphics render without a reboot.
profile=/etc/apparmor.d/scarlet-chrome-headless-shell
if [ "$1" = configure ] && [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser --replace --write-cache --skip-read-cache "$profile" ||
    echo "Scarlet could not load $profile. Restart the computer before rendering motion graphics." >&2
fi
exit 0
