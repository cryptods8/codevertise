#!/usr/bin/env bash
# Rebuild & redeploy the marketplace server on the prod box.
#
# Runs in the deploy checkout (/opt/codevertise) next to the untracked
# .env.prod / docker-compose.yml. Called by the post-receive hook of
# /opt/codevertise.git on every push to main, or manually:
#
#   ssh root@<host> /opt/codevertise/scripts/deploy.sh
set -euo pipefail

# The post-receive hook runs with GIT_DIR pointing at the bare repo;
# drop it so git commands below operate on the deploy checkout.
unset GIT_DIR GIT_WORK_TREE

cd "$(dirname "$(readlink -f "$0")")/.."

git pull --ff-only origin main
echo "deploying $(git rev-parse --short HEAD): $(git log -1 --format=%s)"

docker build -t codevertise .
# --wait blocks until the container's HEALTHCHECK reports healthy
# (and fails the deploy if it never does).
docker compose up -d --wait
docker image prune -f >/dev/null

echo "deploy ok: $(docker compose ps --format '{{.Name}} {{.Status}}')"
