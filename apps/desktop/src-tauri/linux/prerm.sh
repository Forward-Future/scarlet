#!/bin/sh
set -e
profile=/etc/apparmor.d/scarlet-chrome-headless-shell
if [ "$1" = remove ] && [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser --remove "$profile" >/dev/null 2>&1 || true
fi
exit 0
