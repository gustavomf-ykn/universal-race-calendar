#!/usr/bin/env bash
set -euo pipefail
# Ubuntu 24.04 only. No secrets, migrations, application start or schedules.
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && "$(dpkg --print-architecture)" == amd64 ]] || { echo "Ubuntu 24.04 required"; exit 1; }
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin python3
sudo systemctl enable --now docker
sudo install -d -m 0700 /etc/runfinder/staging
sudo install -d -m 0755 /opt/runfinder/deploy/aws
echo "Docker prepared; API and workers remain stopped."
