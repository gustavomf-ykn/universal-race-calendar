"""Small real discovery through the local API; SQL is read-only observation."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import runpy
import time
import httpx

ROOT = Path(__file__).resolve().parents[1]
c = runpy.run_path(str(ROOT / "scripts/local-staging.py"))
env = c["environment"]()
parser = argparse.ArgumentParser()
parser.add_argument("source", choices=["ticketsports", "corridasbr", "openresults"])
parser.add_argument("--repeat", action="store_true")
args = parser.parse_args()
source = args.source
report_file = c["RUNTIME"] / ("calendar-" + source + ("-dedup" if args.repeat else "") + ".json")
api = "http://127.0.0.1:3000"
report = {"projectRef": c["REF"], "source": source, "requestedBatch": 5, "repeatIntent": args.repeat,
          "startedAt": datetime.now(timezone.utc).isoformat()}
stage = "identity"
def counts(db):
    return {"events": db.execute('SELECT count(*) FROM "Event"').fetchone()[0],
            "published": db.execute('SELECT count(*) FROM "Event" WHERE "publicationStatus"=\'published\'').fetchone()[0],
            "references": db.execute('SELECT count(*) FROM "EventSourceReference" WHERE "sourceType"=%s', (source,)).fetchone()[0],
            "results": db.execute('SELECT count(*) FROM "RaceResult"').fetchone()[0]}
try:
    version = httpx.get(api + "/v1/version", timeout=15).json()
    if version.get("supabaseProjectRef") != c["REF"] or version.get("environmentProfile", {}).get("id") != "local-staging":
        raise RuntimeError("local_api_identity_mismatch")
    report["gitSha"] = version["gitSha"]
    with c["connection"](env) as db, httpx.Client(base_url=api, headers={"X-API-Key": env["INTERNAL_API_KEY"]}, timeout=30) as client:
        db.execute("SET default_transaction_read_only=on")
        source_control = db.execute('SELECT "blockedAt" FROM "SourceRequestControl" WHERE source=%s', (source,)).fetchone()
        if args.repeat and source_control and source_control[0]:
            raise RuntimeError("blocked_source_not_repeated")
        if report_file.exists():
            report = json.loads(report_file.read_text(encoding="utf-8"))
        else:
            blocked = db.execute('SELECT "blockedAt" FROM "SourceRequestControl" WHERE source=%s', (source,)).fetchone()
            if blocked and blocked[0]:
                raise RuntimeError("blocked_source_not_repeated")
            report["before"] = counts(db)
            payload = {"source": source, "states": ["SC"], "batchSize": 5, "snapshotLimit": 25,
                       "discoveryMode": "national", "prefixLimit": 25, "autoContinue": False}
            key = "local-pilot-" + source + ("-dedup-v1" if args.repeat else "-v1")
            stage = "enqueue"
            response = client.post("/v1/admin/syncs", json=payload, headers={"Idempotency-Key": key})
            if response.status_code != 202:
                raise RuntimeError("enqueue_http_" + str(response.status_code))
            task_id = response.json()["id"]
            report.update(taskId=task_id, acceptedStatus=202)
            report_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
            replay = client.post("/v1/admin/syncs", json=payload, headers={"Idempotency-Key": key})
            if replay.status_code != 202 or replay.json()["id"] != task_id:
                raise RuntimeError("idempotency_replay_different_task")
            report["sameKeySameTask"] = True
        # Recover observation after a client interruption without creating another intent.
        if not report.get("syncId"):
            row = db.execute('SELECT payload->>\'syncId\' FROM "CollectionTask" WHERE id=%s', (report["taskId"],)).fetchone()
            if not row or not row[0]:
                raise RuntimeError("sync_identity_not_found")
            report["syncId"] = row[0]
        task_id, sync_id = report["taskId"], report["syncId"]
        stage = "workers"
        deadline = time.monotonic() + 300
        while True:
            rows = db.execute('SELECT id,kind,status,"errorCode","executionHold",attempt FROM "CollectionTask" WHERE payload->>\'syncId\'=%s ORDER BY "createdAt"', (sync_id,)).fetchall()
            block = db.execute('SELECT "blockedAt" FROM "SourceRequestControl" WHERE source=%s', (source,)).fetchone()
            if (block and block[0]) or any(r[4] for r in rows) or (rows and all(r[2] in ("completed", "failed", "partial", "cancelled") for r in rows)) or time.monotonic() > deadline:
                break
            time.sleep(5)
        report["tasks"] = [{"id": r[0], "kind": r[1], "status": r[2], "errorCode": r[3], "held": r[4], "attempt": r[5]} for r in rows]
        report["sourceBlocked"] = bool(block and block[0])
        sync = db.execute('SELECT status,coverage,discovered,processed,"createdCount","existingCount" FROM "CatalogSync" WHERE id=%s', (sync_id,)).fetchone()
        report["sync"] = dict(zip(("status", "coverage", "discovered", "processed", "created", "existing"), sync))
        report["after"] = counts(db)
        report["newEvents"] = report["after"]["events"] - report["before"]["events"]
        report["newSourceReferences"] = report["after"]["references"] - report["before"]["references"]
        report["newPublished"] = report["after"]["published"] - report["before"]["published"]
        report["status"] = "source_access_blocked" if report["sourceBlocked"] else (
            "passed" if rows and all(r[2] == "completed" for r in rows) else "partial_or_waiting")
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
except Exception as error:
    reason = str(error)
    report.update(status="failed", failedStage=stage,
                  reason=reason if reason.replace("_", "").isalnum() and len(reason) < 80 else "pilot_check_failed")
report_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
raise SystemExit(0 if report.get("status") == "passed" else 2)
