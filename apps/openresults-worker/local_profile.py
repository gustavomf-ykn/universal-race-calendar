"""Public profile and destination checks. No credential values in exceptions."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

def runtime_profile(env=None):
    env = os.environ if env is None else env
    if not env.get("RUNFINDER_PROFILE"):
        return None
    try:
        config = json.loads(Path(env["RUNFINDER_PROFILE_CONFIG"]).read_text(encoding="utf-8"))
        p = config["profiles"][env["RUNFINDER_PROFILE"]]
        cap = p["catalogPilot"]
        if (config["version"] != 1 or p["id"] != env["RUNFINDER_PROFILE"] or
                len(p["projectRef"]) != 20 or not p["projectRef"].isascii() or not p["projectRef"].islower() or
                not p["projectRef"].isalpha() or p["supabaseUrl"] != "https://" + p["projectRef"] + ".supabase.co" or
                cap != {"states": ["SC"], "batchSize": 5, "prefixLimit": 25, "collectionQuantity": 5}):
            raise ValueError()
        return p
    except Exception:
        raise RuntimeError("runtime_profile_invalid") from None

def assert_runtime_destination(env=None, names=("WORKER_DATABASE_URL",)):
    env = os.environ if env is None else env
    p = runtime_profile(env)
    if not p:
        return
    try:
        ref = p["projectRef"]
        if env.get("SUPABASE_URL") != p["supabaseUrl"] or env.get("EXPECTED_SUPABASE_PROJECT_REF") != ref:
            raise ValueError()
        for name in names:
            u = urlsplit(env[name]); q = parse_qs(u.query, keep_blank_values=True)
            direct = u.hostname == "db." + ref + ".supabase.co" and u.username == "postgres"
            session = bool(u.hostname and u.hostname.endswith(".pooler.supabase.com") and u.username == "postgres." + ref)
            if (u.scheme not in ("postgres", "postgresql") or not (direct or session) or not u.password or
                    u.path != "/postgres" or u.port not in (None, 5432) or q.get("sslmode") not in (["require"], ["verify-full"])):
                raise ValueError()
            if name == "WORKER_DATABASE_URL" and any(k in q for k in ("schema", "pgbouncer", "connection_limit", "pool_timeout")):
                raise ValueError()
    except Exception:
        raise RuntimeError("runtime_destination_rejected") from None

def assert_pilot_task(kind, payload):
    p = runtime_profile()
    if not p:
        return
    c = p["catalogPilot"]
    try:
        if kind in ("calendar", "catalog-sync"):
            states = payload.get("states")
            if not isinstance(states, list) or not states or any(s not in c["states"] for s in states):
                raise ValueError()
        if kind == "calendar" and not 1 <= int(payload["quantity"]) <= c["collectionQuantity"]:
            raise ValueError()
        if kind == "discover" and (int(payload.get("limit", 25)) > c["collectionQuantity"] or int(payload.get("maxPages", 1)) > 1):
            raise ValueError()
        if kind == "catalog-sync" and (int(payload.get("batchSize", 25)) > c["batchSize"] or
                int(payload.get("prefixLimit", 10000)) > c["prefixLimit"]):
            raise ValueError()
    except Exception:
        raise RuntimeError("pilot_scope_exceeded") from None
