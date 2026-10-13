#!/usr/bin/env bash
set -euo pipefail
cd /opt/runfinder/deploy/aws
# A deliberate stop must never be undone by the liveness watchdog.
sudo install -m 600 /dev/null /etc/runfinder/staging/workers-paused
sudo systemctl stop runfinder-watchdog.timer runfinder-watchdog.service 2>/dev/null || true
sudo docker compose --env-file release.env -f compose.yaml --profile workers stop -t 1860 calendar-worker results-worker
echo "Workers stopped after current task or lease recovery deadline."
