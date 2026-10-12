#!/bin/sh
# The secret the routines worker presents when it hands a due run to the API beside it.
#
# Both processes live in this container and the handoff endpoint is on the API's own port, so the
# secret only has to be one both sides know. Generated per boot rather than required, for the reason
# the computer token is: an operator should not have to invent a shared secret for two processes
# they cannot address separately. Set WORKER_SHARED_SECRET yourself and this leaves it be.
#
# Written into the container environment, which `with-contenv` hands to the API and the worker
# alike. It is NOT on the computer service's allow-list, so the Bot's shell never sees it.
set -eu
if [ -z "${WORKER_SHARED_SECRET:-}" ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' \
    > /run/s6/container_environment/WORKER_SHARED_SECRET
fi

chmod 0700 /run/s6/container_environment
