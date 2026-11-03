"""Real new-project Auth/CORS checks. No workers, sources, secrets or athlete rows."""
import json
import os
from pathlib import Path
import runpy
import secrets
import subprocess
import sys
import time
import httpx

ROOT = Path(__file__).resolve().parents[1]
context = runpy.run_path(str(ROOT / "scripts/local-staging.py"))
env = context["environment"]()
REF, BASE = context["REF"], env["SUPABASE_URL"]
RUNTIME = context["RUNTIME"]
API = "http://127.0.0.1:3302"
admin_headers = {"apikey": env["SUPABASE_SECRET_KEY"]}
public_headers = {"apikey": env["SUPABASE_PUBLISHABLE_KEY"]}
users = []
process = None
report = {"projectRef": REF, "checks": {}, "temporaryUsersRemoved": False}
stage = "signing_keys"
def call(method, url, status, **kwargs):
    r = httpx.request(method, url, timeout=25, follow_redirects=False, **kwargs)
    if r.status_code != status:
        raise RuntimeError("unexpected_http_" + str(r.status_code))
    return r.json() if r.content else None
try:
    keys = call("GET", BASE + "/auth/v1/.well-known/jwks.json", 200)
    if not {"ES256", "RS256"}.intersection(k.get("alg") for k in keys.get("keys", [])):
        raise RuntimeError("asymmetric_signing_key_required")
    report["checks"]["compatible_jwks"] = "passed"
    env["PORT"] = "3302"
    process = subprocess.Popen(["node", str(ROOT / "apps/api/dist/apps/api/src/server.js")],
                               cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stage = "api_start"
    for _ in range(30):
        try:
            call("GET", API + "/health", 200)
            break
        except Exception:
            if process.poll() is not None:
                raise RuntimeError("api_start_failed")
            time.sleep(1)
    call("GET", API + "/ready", 200)
    version = call("GET", API + "/v1/version", 200)
    if version["supabaseProjectRef"] != REF:
        raise RuntimeError("api_project_mismatch")
    report["checks"]["ready_and_project_identity"] = "passed"
    tokens = {}
    for role in ("admin", "member"):
        stage = "create_" + role
        email = "runfinder-test-" + secrets.token_hex(12) + "@example.com"
        password = secrets.token_urlsafe(32)
        user = call("POST", BASE + "/auth/v1/admin/users", 200, headers=admin_headers,
                    json={"email": email, "password": password, "email_confirm": True, "app_metadata": {"role": role}})
        users.append(user["id"])
        (RUNTIME / "auth-users-requiring-cleanup.json").write_text(json.dumps(users), encoding="utf-8")
        stage = "login_" + role
        session = call("POST", BASE + "/auth/v1/token?grant_type=password", 200, headers=public_headers,
                       json={"email": email, "password": password})
        tokens[role] = {"Authorization": "Bearer " + session["access_token"]}
    for name, headers, status in (
        ("admin_allowed", tokens["admin"], 200), ("missing_token", {}, 401),
        ("invalid_token", {"Authorization": "Bearer invalid"}, 401), ("member_not_admin", tokens["member"], 403)):
        stage = name
        call("GET", API + "/v1/admin/source-matches", status, headers=headers)
        report["checks"][name] = "passed"
    stage = "client_key_scope_and_revocation"
    key = call("POST", API + "/v1/admin/api-keys", 201, headers=tokens["admin"],
               json={"name": "new-profile-auth-smoke", "scopes": ["results:read"]})
    try:
        call("GET", API + "/v1/tasks", 403, headers={"X-Client-Key": key["key"]})
    finally:
        call("DELETE", API + "/v1/admin/api-keys/" + key["id"], 204, headers=tokens["admin"])
    call("GET", API + "/v1/tasks", 401, headers={"X-Client-Key": key["key"]})
    report["checks"][stage] = "passed"
    for role in ("anon", "member"):
        stage = "operational_tables_denied_" + role
        r = httpx.get(BASE + "/rest/v1/CollectionTask?select=id&limit=1", timeout=20,
                      headers={**public_headers, **(tokens["member"] if role == "member" else {})})
        if r.status_code not in (401, 403):
            raise RuntimeError("operational_table_access_not_denied")
        report["checks"][stage] = "passed"
    for origin in ("https://runfinder-rithmy.lovable.app", "https://id-preview--e21cded7-e20c-4cde-affb-e861bee99b6e.lovable.app"):
        stage = "cors"
        r = httpx.options(API + "/v1/collections", timeout=15, headers={"Origin": origin,
                          "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,idempotency-key,content-type"})
        if r.status_code != 204 or r.headers.get("access-control-allow-origin") != origin:
            raise RuntimeError("cors_preflight_failed")
        allowed = r.headers.get("access-control-allow-headers", "").lower()
        if not all(h in allowed for h in ("authorization", "idempotency-key", "content-type")):
            raise RuntimeError("cors_headers_incomplete")
    report["checks"]["cors_publication_and_preview"] = "passed"
    # The smoke test must never grant privileges to a real user. Explicit owner
    # setup belongs to profile-owner.py; this check only reads its private ID.
    owner_file = RUNTIME / "owner-account.json"
    report["ownerUserAlreadyPresent"] = owner_file.exists()
    if owner_file.exists():
        stage = "owner_admin_metadata"
        owned = json.loads(owner_file.read_text(encoding="utf-8"))
        if owned.get("projectRef") != REF:
            raise RuntimeError("owner_project_mismatch")
        from uuid import UUID
        owner_id = str(UUID(owned["userId"]))
        user = call("GET", BASE + "/auth/v1/admin/users/" + owner_id, 200, headers=admin_headers)
        if user.get("app_metadata", {}).get("role") != "admin":
            raise RuntimeError("owner_admin_not_confirmed")
        report["checks"][stage] = "passed"
    report["status"] = "passed"
except Exception as error:
    reason = str(error)
    report.update(status="failed", failedStage=stage,
                  reason=reason if reason.replace("_", "").isalnum() and len(reason) < 80 else "auth_check_failed")
finally:
    removed = True
    for uid in users:
        try:
            call("DELETE", BASE + "/auth/v1/admin/users/" + uid, 200, headers=admin_headers)
        except Exception:
            removed = False
    report["temporaryUsersRemoved"] = removed
    if removed:
        (RUNTIME / "auth-users-requiring-cleanup.json").unlink(missing_ok=True)
    if process:
        process.terminate()
        process.wait(timeout=15)
    (RUNTIME / "auth-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
raise SystemExit(0 if report.get("status") == "passed" and removed else 1)
