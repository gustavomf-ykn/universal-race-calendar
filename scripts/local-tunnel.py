"""Optional temporary HTTPS transport. Only the public URL is printed."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
import httpx

def install(runtime):
    # Download only a versioned official release asset with a published digest.
    runtime.mkdir(parents=True, exist_ok=True)
    response = httpx.get("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", timeout=30)
    response.raise_for_status()
    asset = next(a for a in response.json()["assets"] if a["name"] == "cloudflared-windows-amd64.exe")
    digest = asset.get("digest", "")
    url = asset["browser_download_url"]
    if not re.fullmatch("sha256:[a-f0-9]{64}", digest) or not url.startswith("https://github.com/cloudflare/cloudflared/releases/download/"):
        raise RuntimeError("official_tunnel_digest_unavailable")
    binary = httpx.get(url, timeout=120, follow_redirects=True)
    binary.raise_for_status()
    if hashlib.sha256(binary.content).hexdigest() != digest[7:]:
        raise RuntimeError("tunnel_digest_mismatch")
    target = runtime / "cloudflared.exe"
    target.write_bytes(binary.content)
    return target

def run(runtime, ref, install_only=False):
    executable = shutil.which("cloudflared")
    if not executable:
        path = runtime / "bin" / "cloudflared.exe"
        if install_only or not path.is_file():
            path = install(runtime / "bin")
        executable = str(path)
    if install_only:
        print(json.dumps({"status": "tunnel_binary_ready", "projectRef": ref}), flush=True)
        return
    r = httpx.get("http://127.0.0.1:3000/v1/version", timeout=10)
    r.raise_for_status()
    v = r.json()
    if v.get("supabaseProjectRef") != ref or v.get("environmentProfile", {}).get("id") != "local-staging":
        raise RuntimeError("local_api_identity_mismatch_no_tunnel_started")
    ready = httpx.get("http://127.0.0.1:3000/ready", timeout=10)
    ready.raise_for_status()
    child = subprocess.Popen([executable, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3000"],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    published = None
    try:
        for line in child.stdout:
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if match and not published:
                published = {"status": "tunnel_started", "projectRef": ref, "publicUrl": match.group(),
                             "startedAt": datetime.now(timezone.utc).isoformat()}
                (runtime / "tunnel-public.json").write_text(json.dumps(published), encoding="utf-8")
                print(json.dumps(published), flush=True)
        if child.wait() != 0:
            raise RuntimeError("temporary_tunnel_stopped")
    except KeyboardInterrupt:
        pass
    finally:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()
        (runtime / "tunnel-public.json").unlink(missing_ok=True)
        print(json.dumps({"status": "tunnel_stopped", "projectRef": ref}), flush=True)
