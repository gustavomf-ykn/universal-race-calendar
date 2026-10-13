#!/usr/bin/env bash
set -euo pipefail
cd /opt/runfinder/deploy/aws
sudo docker compose --env-file release.env -f compose.yaml --profile workers stop -t 1860 calendar-worker results-worker
echo "Workers stopped after current task or lease recovery deadline."
