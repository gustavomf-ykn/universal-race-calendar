#!/usr/bin/env bash
set -euo pipefail
cd /opt/runfinder/deploy/aws
sudo docker compose --env-file release.env -f compose.yaml --profile workers ps
# Do not print inspect/config/env; those may contain privileged credentials.
sudo docker compose --env-file release.env -f compose.yaml exec -T api node -e "fetch('http://127.0.0.1:3000/ready').then(async r=>console.log(r.status,await r.text())).catch(()=>process.exit(1))"
sudo docker compose --env-file release.env -f compose.yaml exec -T api node -e "fetch('http://127.0.0.1:3000/v1/version').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"
