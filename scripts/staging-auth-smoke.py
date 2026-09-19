"""Real staging Auth checks; credentials remain in memory, temporary users are removed."""
import json
import os
import secrets
import subprocess
import time
from pathlib import Path

import httpx as requests

BASE = os.environ["SUPABASE_URL"]
assert BASE == "https://sggrijhyblejlgimgzzc.supabase.co"
API = "http://127.0.0.1:3301"
admin_headers = {"apikey": os.environ["SUPABASE_SECRET_KEY"]}
public_headers = {"apikey": os.environ["SUPABASE_PUBLISHABLE_KEY"]}
users = []
report = {"projectRef": "sggrijhyblejlgimgzzc", "checks": {}, "temporaryUsersRemoved": False}
process = None
stage = "start"

def call(method, url, expected, **kwargs):
    response = requests.request(method, url, timeout=20, **kwargs)
    if response.status_code != expected:
        raise RuntimeError(f"unexpected_http_{response.status_code}")
    return response.json() if response.content else None

try:
    env = dict(os.environ, PORT="3301", NODE_ENV="production")
    process = subprocess.Popen(["node", "apps/api/dist/apps/api/src/server.js"], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        try:
            call("GET", API + "/health", 200)
            break
        except Exception:
            time.sleep(1)
    tokens = {}
    for role in ["admin", "member"]:
        stage = "create_" + role
        email = f"staging-{secrets.token_hex(10)}@example.com"
        password = secrets.token_urlsafe(32)
        user = call("POST", BASE + "/auth/v1/admin/users", 200, headers=admin_headers,
                    json={"email": email, "password": password, "email_confirm": True,
                          "app_metadata": {"role": role}})
        users.append(user["id"])
        stage = "login_" + role
        session = call("POST", BASE + "/auth/v1/token?grant_type=password", 200,
                       headers=public_headers, json={"email": email, "password": password})
        tokens[role] = {"Authorization": "Bearer " + session["access_token"]}
    for name, headers, expected in [
        ("admin_login", tokens["admin"], 200),
        ("missing_token", {}, 401),
        ("invalid_token", {"Authorization": "Bearer invalid"}, 401),
        ("member_not_admin", tokens["member"], 403),
    ]:
        stage = name
        call("GET", API + "/v1/admin/source-matches", expected, headers=headers)
        report["checks"][name] = "passed"
    stage = "create_scoped_key"
    key = call("POST", API + "/v1/admin/api-keys", 201, headers=tokens["admin"],
               json={"name": "staging-auth-smoke", "scopes": ["results:read"]})
    try:
        stage = "insufficient_scope"
        call("GET", API + "/v1/tasks", 403, headers={"X-Client-Key": key["key"]})
        report["checks"][stage] = "passed"
    finally:
        call("DELETE", API + "/v1/admin/api-keys/" + key["id"], 204, headers=tokens["admin"])
    stage = "revoked_key"
    call("GET", API + "/v1/tasks", 401, headers={"X-Client-Key": key["key"]})
    report["checks"][stage] = "passed"
    for role in ["anon", "member"]:
        stage = "postgrest_denied_" + role
        headers = dict(public_headers, **(tokens["member"] if role == "member" else {}))
        response = requests.get(BASE + "/rest/v1/CollectionTask?select=id&limit=1", headers=headers, timeout=20)
        assert response.status_code in [401, 403]
        report["checks"][stage] = "passed"
    report["status"] = "passed"
except Exception as error:
    report.update(status="failed", failedStage=stage, errorType=type(error).__name__)
finally:
    removed = True
    for user_id in users:
        try:
            call("DELETE", BASE + "/auth/v1/admin/users/" + user_id, 200, headers=admin_headers)
        except Exception:
            removed = False
    report["temporaryUsersRemoved"] = removed
    if not removed:
        report["usersRequiringCleanup"] = users
    if process:
        process.terminate()
        process.wait(timeout=15)
    Path(".secrets/staging-auth-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
raise SystemExit(0 if report.get("status") == "passed" and report["temporaryUsersRemoved"] else 1)
