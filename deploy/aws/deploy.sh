#!/usr/bin/env bash
set -euo pipefail
cd /opt/runfinder/deploy/aws
[[ "${1:-}" == api || "${1:-}" == workers ]] || { echo "Usage: deploy.sh api|workers"; exit 1; }
sudo python3 preflight.py release.env
# Secrets never appear in compose config, command arguments, history or logs.
version=$(docker compose version --short)
python3 -c 'import sys; v=sys.argv[1].lstrip("v").split("."); sys.exit(0 if tuple(map(int,v[:2])) >= (2,30) else 1)' "$version"
sudo docker compose --env-file release.env -f compose.yaml config --quiet
if [[ "$1" == api ]]; then
 sudo docker compose --env-file release.env -f compose.yaml pull api caddy
 sudo python3 verify-images.py release.env api
 sudo docker compose --env-file release.env -f compose.yaml up -d --wait api caddy
else
 sudo docker compose --env-file release.env -f compose.yaml exec -T api node -e "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
 [[ -f /etc/runfinder/staging/worker-approval.json ]] || { echo "Inventory and approve pending task IDs first; workers remain stopped."; exit 1; }
 sudo docker compose --env-file release.env -f compose.yaml run --rm --no-deps --user 0 -v /etc/runfinder/staging/worker-approval.json:/runfinder/worker-approval.json:ro api node scripts/aws-queue-preflight.mjs /runfinder/worker-approval.json
 sudo docker compose --env-file release.env -f compose.yaml --profile workers pull calendar-worker results-worker
 sudo python3 verify-images.py release.env workers
 sudo docker compose --env-file release.env -f compose.yaml --profile workers up -d --wait calendar-worker results-worker
fi
echo "Release started; validate task outcomes independently."
