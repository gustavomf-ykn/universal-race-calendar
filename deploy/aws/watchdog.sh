#!/usr/bin/env bash
set -euo pipefail
cd /opt/runfinder/deploy/aws
[[ ! -e /etc/runfinder/staging/workers-paused ]] || exit 0
# Readiness failure is an external dependency problem; do not churn all workers.
sudo docker compose --env-file release.env -f compose.yaml exec -T api node -e "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 || exit 0
for service in calendar-worker results-worker; do
 id=$(sudo docker compose --env-file release.env -f compose.yaml --profile workers ps -q "$service")
 [[ -n "$id" ]] || continue
 health=$(sudo docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
 if [[ "$health" == unhealthy ]]; then
  echo "$service heartbeat stale; restarting for lease recovery."
  sudo docker compose --env-file release.env -f compose.yaml --profile workers restart --timeout 30 "$service"
 fi
done
