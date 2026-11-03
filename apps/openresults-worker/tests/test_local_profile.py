import os
from pathlib import Path
import pytest
from local_profile import runtime_profile, assert_runtime_destination, assert_pilot_task

REF = "gpkodfsofwiroskdmeax"
CONFIG = Path(__file__).resolve().parents[3] / "config" / "staging-profiles.json"
URI = "postgresql://postgres." + REF + ":synthetic-password@aws-0.test.pooler.supabase.com:5432/postgres?sslmode=require"
def env():
    return {"RUNFINDER_PROFILE": "local-staging", "RUNFINDER_PROFILE_CONFIG": str(CONFIG),
            "EXPECTED_SUPABASE_PROJECT_REF": REF, "SUPABASE_URL": "https://" + REF + ".supabase.co",
            "WORKER_DATABASE_URL": URI}

def test_profile_has_no_legacy_fallback():
    assert runtime_profile({}) is None
    assert runtime_profile(env())["projectRef"] == REF
    assert_runtime_destination(env())

@pytest.mark.parametrize("field,value", [
    ("SUPABASE_URL", "https://sggrijhyblejlgimgzzc.supabase.co"),
    ("WORKER_DATABASE_URL", URI.replace(":5432", ":6543")),
    ("WORKER_DATABASE_URL", URI + "&schema=public"),
    ("WORKER_DATABASE_URL", URI + "&sslmode=disable"),
    ("WORKER_DATABASE_URL", URI.replace(REF, "sggrijhyblejlgimgzzc")),
])
def test_profile_rejects_mixed_or_incompatible_connections(field, value):
    with pytest.raises(RuntimeError, match="runtime_destination_rejected"):
        assert_runtime_destination({**env(), field: value})

def test_worker_checks_pilot_before_source_io(monkeypatch):
    for key, value in env().items():
        monkeypatch.setenv(key, value)
    assert_pilot_task("catalog-sync", {"states": ["SC"], "batchSize": 5, "prefixLimit": 25})
    with pytest.raises(RuntimeError, match="pilot_scope_exceeded"):
        assert_pilot_task("catalog-sync", {"states": ["SC"], "batchSize": 25, "prefixLimit": 10000})
