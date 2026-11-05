#!/usr/bin/env bash
# start Docker Desktop when it is off; local.sh sources this, lma init runs it before there is a config

need_docker() {
  command -v docker >/dev/null || { red "docker is not installed / not on PATH"; exit 1; }
  if ! docker info >/dev/null 2>&1; then
    if [ "$ASSUME_YES" != "1" ]; then
      [ -t 0 ] || { red "Docker is not running, and there is no terminal to ask on. Start it, or pass --yes."; exit 1; }
      read -r -p "Docker is not running. Start Docker Desktop? [y/N] " ans || ans=""
      case "$ans" in y|Y|yes|YES) ;; *) note "aborted"; exit 1 ;; esac
    fi
    if [ "$(uname)" = "Darwin" ]; then
      note "starting Docker Desktop..."
      open -g -a Docker || { red "could not launch Docker Desktop"; exit 1; }
    else
      red "start the docker daemon first (e.g. systemctl start docker)"; exit 1
    fi
    local start_ts=$SECONDS
    while [ $((SECONDS - start_ts)) -lt 120 ]; do
      docker info >/dev/null 2>&1 && { green "docker is up"; return 0; }
      sleep 2
    done
    red "docker did not become ready in 120s; open Docker Desktop and check it manually"; exit 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  red()   { printf '\033[31m%s\033[0m\n' "$*"; }
  green() { printf '\033[32m%s\033[0m\n' "$*"; }
  note()  { printf '\033[36m%s\033[0m\n' "$*"; }
  ASSUME_YES=0
  case "${1:-}" in -y|--yes) ASSUME_YES=1 ;; esac
  need_docker
fi
