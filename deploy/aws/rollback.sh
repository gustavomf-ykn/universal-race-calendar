#!/usr/bin/env bash
set -euo pipefail
cd /opt/runfinder/deploy/aws
[[ "${1:-}" == previous-release.env ]] || { echo "Usage: rollback.sh previous-release.env"; exit 1; }
sudo python3 preflight.py previous-release.env
bash ./stop.sh
# Only application rollback; never reset/drop the database or reverse migrations.
sudo docker compose --env-file previous-release.env -f compose.yaml up -d --wait api caddy
echo "Previous compatible API started. Approve schema compatibility before starting previous workers."
