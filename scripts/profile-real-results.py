"""Resumable, bounded real-edition pilot. Private reports contain no athlete rows/URLs signed for access."""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import runpy
import time
import unicodedata
from urllib.parse import urlsplit

import httpx
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
c = runpy.run_path(str(ROOT / "scripts/local-staging.py"))
env = c["environment"]()
FILE = c["RUNTIME"] / "real-results-report.json"
report = json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() else {
    "projectRef": c["REF"], "tasks": {}, "checks": {}}
parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["prepare", "associate", "review", "collect", "retry", "export"])
args = parser.parse_args()
API = "http://127.0.0.1:3000"
TICKET = "https://site.ticketsports.com.br/Inscricao/categoria.aspx?__idEvento=74857"
RESULTS = "https://openresults.run/evento/2026-mountain-do-costao-do-santinho-2026/"


def save():
    FILE.write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")


def call(method, path, expected=200, **kwargs):
    response = client.request(method, path, **kwargs)
    if response.status_code != expected:
        try:
            code = response.json().get("error", "")
        except ValueError:
            code = ""
        safe = code if code.replace("_", "").isalnum() and len(code) < 90 else "request_failed"
        raise RuntimeError("http_" + str(response.status_code) + "_" + safe)
    return response.json()


def task(label, path, payload=None):
    # Fixed intent per operation: interrupted diagnostics never make a second collection.
    key = "new-local-real-v1-" + label
    first = call("POST", path, 202, json=payload, headers={"Idempotency-Key": key})
    again = call("POST", path, 202, json=payload, headers={"Idempotency-Key": key})
    if first["id"] != again["id"]:
        raise RuntimeError("idempotency_task_mismatch")
    report["tasks"][label] = {"id": first["id"], "sameKeySameTask": True}
    save()
    deadline = time.monotonic() + 360
    while True:
        row = call("GET", "/v1/tasks/" + first["id"])
        if row["status"] in ("completed", "partial", "failed", "cancelled") or row.get("executionHold") or time.monotonic() > deadline:
            break
        time.sleep(3)
    report["tasks"][label].update({k: row.get(k) for k in ("status", "attempt", "errorCode")})
    report["tasks"][label]["progress"] = {k: v for k, v in (row.get("progress") or {}).items()
        if k in ("stage", "percent", "processed", "failed", "total", "inserted", "preserved")
        and isinstance(v, (int, float, str, bool))}
    save()
    if row["status"] != "completed":
        raise RuntimeError("task_" + row["status"])
    return row


def folded(value):
    return " ".join("".join(x for x in unicodedata.normalize("NFD", value or "")
                            if not unicodedata.combining(x)).casefold().split())


def identity():
    row = db.execute('SELECT id,name,date,city,state,country,modality FROM "Event" WHERE id=%s',
                     (report["eventId"],)).fetchone()
    match = db.execute('SELECT id,name,date,city,state,country FROM "SourceMatch" WHERE source=\'openresults\' AND "externalId"=\'37007\'').fetchone()
    if not row or not match:
        raise RuntimeError("edition_identity_missing")
    event = dict(zip(("id", "name", "date", "city", "state", "country", "modality"), row))
    observed = dict(zip(("id", "name", "date", "city", "state", "country"), match))
    def date_value(value):
        return value.date().isoformat() if value else None
    event["date"], observed["date"] = date_value(event["date"]), date_value(observed["date"])
    report["identity"] = {"calendar": event, "resultsSource": observed}
    save()
    if event["date"] != "2026-07-25" or event["date"] != observed["date"]:
        raise RuntimeError("edition_date_not_verified")
    if not all(folded(event[f]) and folded(event[f]) == folded(observed[f]) for f in ("city", "state")):
        raise RuntimeError("edition_location_not_verified")
    if event["country"] != "BR" or (observed["country"] and observed["country"] != event["country"]):
        raise RuntimeError("edition_country_conflict")
    report["identity"]["countryEvidence"] = "both_sources" if observed["country"] else "calendar_only_results_country_absent"
    if not all("santinho" in folded(o["name"]) and "2026" in o["name"] for o in (event, observed)):
        raise RuntimeError("edition_name_not_verified")
    return event, observed


try:
    version = httpx.get(API + "/v1/version", timeout=15).json()
    if version.get("supabaseProjectRef") != c["REF"]:
        raise RuntimeError("api_project_mismatch")
    report["gitSha"] = version["gitSha"]
    with c["connection"](env) as db, httpx.Client(base_url=API, timeout=30,
            headers={"X-API-Key": env["INTERNAL_API_KEY"]}) as client:
        db.execute("SET default_transaction_read_only=on")
        if args.action == "prepare":
            blocked = db.execute('SELECT source FROM "SourceRequestControl" WHERE "blockedAt" IS NOT NULL').fetchall()
            if any(r[0] in ("ticketsports", "openresults") for r in blocked):
                raise RuntimeError("source_access_blocked")
            source = next((s for s in call("GET", "/v1/sources")["data"]
                           if s.get("adapter") == "ticketsports" and s.get("externalId") == "74857"), None)
            if not source:
                source = call("POST", "/v1/sources", 201, json={"name": "TicketSports 74857 verification",
                    "url": TICKET, "type": "registration_page", "adapter": "ticketsports", "externalId": "74857"})
            task("calendar-metadata", "/v1/sources/" + source["id"] + "/check")
            row = db.execute('SELECT "eventId" FROM "EventSourceReference" WHERE "sourceType"=\'ticketsports\' AND "sourceExternalId"=\'74857\'').fetchone()
            if not row:
                raise RuntimeError("calendar_edition_not_persisted")
            report["eventId"] = row[0]
            save()
            task("results-metadata", "/v1/admin/source-matches", {"url": RESULTS})
            identity()
        elif args.action == "associate":
            _, match = identity()
            result = call("POST", "/v1/admin/source-matches/" + match["id"] + "/resolve", json={"eventId": report["eventId"]})
            if result.get("eventId") != report["eventId"]:
                raise RuntimeError("source_association_failed")
            report["checks"]["source_association"] = "passed"
            report["prepare"] = "passed"
        elif args.action == "review":
            identity()
            description = db.execute('SELECT description FROM "Event" WHERE id=%s', (report["eventId"],)).fetchone()[0]
            if "trilhas, bosques, praias e dunas" not in folded(description):
                raise RuntimeError("trail_description_evidence_missing")
            call("PATCH", "/v1/admin/catalog/events/" + report["eventId"], json={
                "modality": "trail", "reason": "Reviewed TicketSports 74857: explicit trails, woodland, beaches and dunes description; primary 5/9/21/42km courses."})
            call("POST", "/v1/admin/events/" + report["eventId"] + "/publish")
            report["checks"]["reviewed_publication"] = "passed"
        elif args.action in ("collect", "retry"):
            identity()
            blocked = db.execute('SELECT "blockedAt" FROM "SourceRequestControl" WHERE source=\'openresults\'').fetchone()
            if blocked and blocked[0]:
                raise RuntimeError("source_access_blocked")
            if args.action == "retry":
                old = report["tasks"]["real-results"]
                if old.get("errorCode") != "source_structure_changed":
                    raise RuntimeError("retry_requires_reviewed_structure_failure")
                task("real-results-retry", "/v1/tasks/" + old["id"] + "/retry", {"mode": "restart"})
            else:
                task("real-results", "/v1/collections", {"source": "openresults", "eventId": report["eventId"]})
            rows = db.execute('SELECT r.modality,count(*) FROM "RaceResult" r JOIN "ResultSet" s ON s.id=r."resultSetId" WHERE s."eventId"=%s GROUP BY r.modality ORDER BY r.modality',
                              (report["eventId"],)).fetchall()
            report["modalities"] = [{"modality": r[0], "count": r[1]} for r in rows]
            report["resultCount"] = sum(r[1] for r in rows)
            if report["resultCount"] <= 0:
                raise RuntimeError("no_results_persisted")
        else:
            event_id = report["eventId"]
            all_ids = set()
            p = 1
            while True:
                data = call("GET", f"/v1/events/{event_id}/results?page={p}&limit=100")
                all_ids.update(r["id"] for r in data["data"])
                if p >= data["pagination"]["totalPages"]:
                    break
                p += 1
            if len(all_ids) != report["resultCount"] or data["pagination"]["total"] != len(all_ids):
                raise RuntimeError("results_pagination_mismatch")
            report["checks"]["paginated_results"] = {"pages": p, "rows": len(all_ids)}
            for modality in report["modalities"]:
                data = call("GET", f"/v1/events/{event_id}/results", params={"modality": modality["modality"], "limit": 1})
                if data["pagination"]["total"] != modality["count"]:
                    raise RuntimeError("modality_count_mismatch")
            report["checks"]["modality_filter"] = "passed"
            key = "new-local-real-v1-export"
            first = call("POST", f"/v1/events/{event_id}/exports", 202, headers={"Idempotency-Key": key})
            again = call("POST", f"/v1/events/{event_id}/exports", 202, headers={"Idempotency-Key": key})
            if first["id"] != again["id"] or first["taskId"] != again["taskId"]:
                raise RuntimeError("export_idempotency_mismatch")
            report["exportId"], report["exportTaskId"] = first["id"], first["taskId"]
            save()
            deadline = time.monotonic() + 180
            while True:
                artifact = call("GET", "/v1/exports/" + first["id"])
                if artifact["status"] in ("completed", "failed", "partial", "cancelled", "expired") or time.monotonic() > deadline:
                    break
                time.sleep(3)
            if artifact["status"] != "completed" or not artifact.get("downloadUrl"):
                raise RuntimeError("export_not_completed")
            signed = artifact["downloadUrl"]
            if urlsplit(signed).hostname != urlsplit(env["SUPABASE_URL"]).hostname:
                raise RuntimeError("storage_project_mismatch")
            downloaded = httpx.get(signed, timeout=30)
            if downloaded.status_code != 200:
                raise RuntimeError("download_failed")
            workbook = load_workbook(io.BytesIO(downloaded.content), read_only=True)
            sheet = workbook.active
            headers = list(next(sheet.iter_rows(values_only=True)))
            count = sum(1 for _ in sheet.iter_rows(min_row=2, values_only=True))
            workbook.close()
            if count != report["resultCount"]:
                raise RuntimeError("xlsx_row_count_mismatch")
            directory = c["RUNTIME"] / "downloads"
            directory.mkdir(exist_ok=True)
            (directory / "real-results.xlsx").write_bytes(downloaded.content)
            report["checks"]["xlsx_download"] = {"rows": count, "headers": headers,
                "bytes": len(downloaded.content), "sha256": hashlib.sha256(downloaded.content).hexdigest(),
                "sameKeySameArtifact": True}
            bucket = httpx.get(env["SUPABASE_URL"] + "/storage/v1/bucket/race-exports",
                headers={"apikey": env["SUPABASE_SECRET_KEY"]}, timeout=20).json()
            if bucket.get("public") is not False:
                raise RuntimeError("bucket_not_private")
            path = db.execute('SELECT "objectPath" FROM "ExportArtifact" WHERE id=%s', (first["id"],)).fetchone()[0]
            unauthorized = httpx.get(env["SUPABASE_URL"] + "/storage/v1/object/public/race-exports/" + path, timeout=20)
            if unauthorized.status_code == 200:
                raise RuntimeError("unsigned_download_allowed")
            report["checks"]["private_bucket_unsigned_denied"] = "passed"
        report[args.action] = "passed"
        report["lastAction"] = args.action
        report["lastCheckedAt"] = datetime.now(timezone.utc).isoformat()
        report.pop("error", None)
except Exception as error:
    reason = str(error)
    report[args.action] = "failed"
    report["error"] = reason if reason.replace("_", "").isalnum() and len(reason) < 100 else "pilot_operation_failed"
save()
print(json.dumps(report, ensure_ascii=True))
raise SystemExit(0 if report.get(args.action) == "passed" else 2)
