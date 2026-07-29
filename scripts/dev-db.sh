#!/usr/bin/env bash
# 開発用Postgres（Docker: postgres:16）の起動/停止/リセットヘルパ。
# 使い方: scripts/dev-db.sh [up|down|reset|status|psql]
# 詳細は docs/dev-database.md を参照。
set -euo pipefail

CONTAINER=driving_school_pg
VOLUME=driving_school_pgdata
IMAGE=postgres:16
DB_USER=driving
DB_PASSWORD=driving_dev_pw
DB_NAME=driving_school
HOST_PORT=5433

docker_bin() { command -v docker; }

up() {
  if ! docker info >/dev/null 2>&1; then
    echo "docker daemon が起動していません。Docker Desktop を起動してください（open -a Docker）。" >&2
    exit 1
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker pull "$IMAGE"
  docker run -d \
    --name "$CONTAINER" \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -e POSTGRES_DB="$DB_NAME" \
    -p "${HOST_PORT}:5432" \
    -v "${VOLUME}":/var/lib/postgresql/data \
    "$IMAGE"
  echo -n "waiting for postgres"
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      echo " ... ready"
      docker ps --filter "name=$CONTAINER" --format '{{.Names}} {{.Status}} {{.Ports}}'
      return 0
    fi
    echo -n "."; sleep 1
  done
  echo " ... FAILED" >&2; exit 1
}

down() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; echo "stopped $CONTAINER (volume $VOLUME kept)"; }

reset() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  echo "removed container and volume; run 'up' then 'pnpm db:migrate && pnpm db:seed'"
}

status() { docker ps -a --filter "name=$CONTAINER" --format '{{.Names}} {{.Status}} {{.Ports}}'; }

psql_shell() { docker exec -it -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"; }

case "${1:-up}" in
  up) up ;;
  down) down ;;
  reset) reset ;;
  status) status ;;
  psql) psql_shell ;;
  *) echo "usage: $0 [up|down|reset|status|psql]" >&2; exit 2 ;;
esac
