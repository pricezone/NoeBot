#!/bin/sh
# The single-container image on Fly.io Machines.
#
# Fly's own init is PID 1 and cannot be replaced, and s6-overlay's `/init` refuses to run as anything
# else ("s6-overlay-suexec: fatal: can only run as pid 1"). So on Fly this script stands in for s6:
# it runs the same oneshots and the same service `run` scripts, in the same order and as the same
# users, without a supervisor in between. Fly restarts the machine when this process exits, which is
# the restart policy s6 would otherwise provide.
#
# It also solves the one-volume problem. A Fly machine mounts exactly one volume, at
# `$OPENBOT_DATA_DIR` (default /data); the image keeps its state in three places. Each is replaced by
# a symlink onto the volume before anything starts, so the embedded Postgres, the Bots' workspace and
# the browser profiles all survive a restart or an image update.
#
# Run as root, like `/init`: the service scripts drop to postgres, pwuser and apiuser themselves.
set -eu

DATA_DIR="${OPENBOT_DATA_DIR:-/data}"
S6_SCRIPTS=/etc/s6-overlay/scripts
S6_SERVICES=/etc/s6-overlay/s6-rc.d
CONTENV=/run/s6/container_environment

# Move a directory the image writes to onto the volume, once, and point the old path at it.
#
# The first boot copies whatever the image shipped there (the empty Postgres data dir, owned by
# postgres) so the init scripts see what they expect; every later boot only refreshes the link.
relocate() {
  source="$1"
  target="$DATA_DIR/$2"
  owner="$3"
  mkdir -p "$target"
  if [ -d "$source" ] && [ ! -L "$source" ]; then
    if [ -z "$(ls -A "$target")" ]; then
      cp -a "$source/." "$target/" 2>/dev/null || true
    fi
    rm -rf "$source"
  fi
  ln -sfn "$target" "$source"
  chown "$owner" "$target"
}

relocate /var/lib/postgresql postgresql postgres:postgres
relocate /workspace workspace pwuser:pwuser
relocate /profiles profiles pwuser:pwuser

# What `with-contenv` reads: the oneshots write generated secrets here (COMPUTER_TOKEN, the
# embedded database's URL), and the services below are started with them exported.
mkdir -p "$CONTENV"
chmod 0700 "$CONTENV"

sh "$S6_SCRIPTS/computer-token.sh"
sh "$S6_SCRIPTS/postgres-init.sh"

for file in "$CONTENV"/*; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  export "$name=$(cat "$file")"
done

pids=""

# A service `run` script, started the way s6 would start it. Each `exec`s into its process, so the
# shell that started it becomes the process and the pid below is the service's own.
start() {
  sh "$S6_SERVICES/$1/run" &
  pids="$pids $!"
  eval "$1_pid=$!"
}

if [ "${EMBEDDED_POSTGRES:-off}" = "on" ]; then
  start postgres
  # The migration and the API need the database to answer first; s6 expressed this as dependencies.
  i=0
  until s6-setuidgid postgres /usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -q; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      echo "fly-entrypoint: the embedded database did not come up." >&2
      exit 1
    fi
    sleep 1
  done
  sh "$S6_SCRIPTS/migrate.sh"
fi

start computer
start api

# Fly stops a machine with SIGTERM; pass it on and let Postgres shut down cleanly before leaving.
shutdown() {
  trap - TERM INT
  kill -TERM ${api_pid:-} ${computer_pid:-} 2>/dev/null || true
  wait ${api_pid:-} ${computer_pid:-} 2>/dev/null || true
  if [ -n "${postgres_pid:-}" ]; then
    kill -TERM "$postgres_pid" 2>/dev/null || true
    wait "$postgres_pid" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

# The API is the product; when it goes, the machine restarts and everything comes back together.
wait "$api_pid"
status=$?
echo "fly-entrypoint: the API exited with status $status; stopping the rest." >&2
shutdown
