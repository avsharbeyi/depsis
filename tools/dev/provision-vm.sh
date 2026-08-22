#!/usr/bin/env bash
#
# Installs what the appliance's newer features need on a development VM, and says what it found.
#
# Three of DEPSIS's features are integrations rather than code: applications run in containers,
# remote access is a ZeroTier network, and the admin console runs real programs. None of those can
# be verified against a stub — a container manager that "works" against a fake socket tells you
# nothing — so a development box needs the real daemons.
#
#   bash tools/dev/provision-vm.sh          install what is missing and report
#   bash tools/dev/provision-vm.sh --check  report only
#
set -uo pipefail

check_only=0
[ "${1:-}" = '--check' ] && check_only=1

say() { printf '%-34s %s\n' "$1" "$2"; }

# The pgdg repository was added twice, once as a one-line .list and once as deb822 .sources, with
# different Signed-By paths for the same key. apt refuses to read ANY source list while that
# conflict stands, so every install on this box fails with an error that names PostgreSQL and has
# nothing to do with what is being installed. Dropping the older one-line file is the fix.
if [ -f /etc/apt/sources.list.d/pgdg.list ] && [ -f /etc/apt/sources.list.d/pgdg.sources ]; then
  if [ "$check_only" = 0 ]; then
    mv /etc/apt/sources.list.d/pgdg.list /etc/apt/sources.list.d/pgdg.list.disabled
    say 'apt sources' 'removed the duplicate pgdg .list'
  else
    say 'apt sources' 'DUPLICATE pgdg entries — apt cannot read any source list'
  fi
fi

want=()
command -v podman        >/dev/null || want+=(podman)
# Rootless podman needs these two to map subuids and to give a container a network; without them
# `podman run` fails at the point where it is hardest to diagnose.
command -v newuidmap     >/dev/null || want+=(uidmap)
command -v slirp4netns   >/dev/null || want+=(slirp4netns)

if [ "${#want[@]}" -gt 0 ] && [ "$check_only" = 0 ]; then
  apt-get update -qq >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${want[@]}" >/tmp/provision-apt.log 2>&1 \
    || { say 'podman' "install FAILED — $(tail -2 /tmp/provision-apt.log | tr '\n' ' ')"; }
fi

if command -v podman >/dev/null; then
  say 'podman' "$(podman --version 2>&1 | head -1)"
  # The API socket is what DEPSIS talks to; the CLI is only how a person checks it by hand. It is
  # socket-activated, so enabling the socket unit is enough — no long-running daemon.
  if [ "$check_only" = 0 ]; then
    systemctl enable --now podman.socket >/dev/null 2>&1
  fi
  if [ -S /run/podman/podman.sock ]; then
    say 'podman socket' '/run/podman/podman.sock'
  else
    say 'podman socket' 'MISSING — systemctl status podman.socket'
  fi
else
  say 'podman' 'not installed'
fi

if command -v zerotier-cli >/dev/null; then
  say 'zerotier' "$(zerotier-cli -v 2>&1 | head -1)"
  [ -f /var/lib/zerotier-one/authtoken.secret ] \
    && say 'zerotier auth token' 'present' \
    || say 'zerotier auth token' 'MISSING — the service has not run yet'
elif [ "$check_only" = 0 ]; then
  # ZeroTier's own front page tells you to pipe a remote script into a root shell. This does not
  # do that. They also publish a normal signed apt repository, and using it means the key is
  # pinned to this one source and every future upgrade goes through apt like everything else —
  # the difference between a package manager and a stranger's shell script.
  codename=$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-trixie}")
  install -d -m 0755 /usr/share/keyrings
  if curl -fsSL 'https://download.zerotier.com/contact%40zerotier.com.gpg' \
       -o /usr/share/keyrings/zerotier.gpg; then
    printf 'deb [signed-by=/usr/share/keyrings/zerotier.gpg] https://download.zerotier.com/debian/%s %s main\n' \
      "$codename" "$codename" > /etc/apt/sources.list.d/zerotier.list
    apt-get update -qq >/dev/null 2>&1
    if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zerotier-one >/tmp/provision-zt.log 2>&1; then
      say 'zerotier' "$(zerotier-cli -v 2>&1 | head -1)"
    else
      say 'zerotier' "install FAILED — $(tail -2 /tmp/provision-zt.log | tr '\n' ' ')"
    fi
  else
    say 'zerotier' 'could not fetch the signing key'
  fi
  # The daemon mints its identity and its local API token on first start, so nothing can talk to
  # it until it has run once.
  systemctl enable --now zerotier-one >/dev/null 2>&1
  [ -f /var/lib/zerotier-one/authtoken.secret ] \
    && say 'zerotier auth token' 'present' \
    || say 'zerotier auth token' 'MISSING — systemctl status zerotier-one'
else
  say 'zerotier' 'not installed'
fi

command -v script >/dev/null && say 'util-linux script' 'present' || say 'util-linux script' 'missing'
