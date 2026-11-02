"""Explicit new-project operations. Secrets are never arguments or log output."""
import argparse
import base64
import ctypes
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "openresults-worker"))
from local_profile import runtime_profile, assert_runtime_destination
PROFILE_CONFIG = ROOT / "config" / "staging-profiles.json"
PROFILE_ENV = {"RUNFINDER_PROFILE": "local-staging", "RUNFINDER_PROFILE_CONFIG": str(PROFILE_CONFIG)}
PROFILE = runtime_profile(PROFILE_ENV)
REF = PROFILE["projectRef"]
RUNTIME = ROOT / ".secrets" / REF
STORE = RUNTIME / "credentials.dpapi.json"

def emit(**values):
    print(json.dumps({"projectRef": REF, **values}, ensure_ascii=False), flush=True)

def protect(data, decrypt=False):
    if os.name != "nt":
        raise RuntimeError("use_protected_environment_on_this_platform")
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_byte))]
    source = ctypes.create_string_buffer(data)
    source_blob = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_byte)))
    target = Blob()
    function = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source_blob), None, None, None, None, 1, ctypes.byref(target)):
        raise RuntimeError("protected_store_unavailable_for_this_user")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        ctypes.windll.kernel32.LocalFree(target.data)

def private_directory():
    for p in (ROOT / ".secrets", RUNTIME):
        if p.exists() and (p.is_symlink() or (getattr(p.stat(), "st_file_attributes", 0) & 0x400)):
            raise RuntimeError("private_directory_reparse_rejected")
        p.mkdir(mode=0o700, exist_ok=True)
    if os.name == "nt":
        identity = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, check=True)
        sid = re.search(r"S-1-[0-9-]+", identity.stdout)
        if not sid:
            raise RuntimeError("private_directory_acl_failed")
        result = subprocess.run(["icacls", str(RUNTIME), "/inheritance:r", "/grant:r",
                                 "*" + sid.group() + ":(OI)(CI)F"], capture_output=True)
        if result.returncode:
            raise RuntimeError("private_directory_acl_failed")

def base_environment(values):
    env = dict(os.environ)
    env.update(values)
    env.update(PROFILE_ENV)
    env.update(SUPABASE_URL=PROFILE["supabaseUrl"], EXPECTED_SUPABASE_PROJECT_REF=REF,
               STAGING_PROJECT_REF=REF, STAGING_PROJECT_NAME=PROFILE["name"], HOST="127.0.0.1", PORT="3000",
               HOSTING_TARGET="local", WORKER_RUNTIME_DIR=str(RUNTIME / "executors"),
               CORS_ORIGINS="https://runfinder-rithmy.lovable.app,https://id-preview--e21cded7-e20c-4cde-affb-e861bee99b6e.lovable.app")
    # Never inherit a selection, stop marker, batch report, or external scheduling intent.
    for key in ("WORKER_TASK_SELECTION_FILE", "WORKER_STOP_FILE", "WORKER_REPORT_PATH", "RENDER_GIT_COMMIT"):
        env.pop(key, None)
    assert_runtime_destination(env, ("DATABASE_URL", "DIRECT_URL", "WORKER_DATABASE_URL"))
    if (not re.fullmatch("sb_secret_[A-Za-z0-9_-]+", env.get("SUPABASE_SECRET_KEY", "")) or
            not re.fullmatch("sb_publishable_[A-Za-z0-9_-]+", env.get("SUPABASE_PUBLISHABLE_KEY", "")) or
            len(env.get("INTERNAL_API_KEY", "")) < 32):
        raise RuntimeError("new_project_keys_required")
    return env

def save_credentials(values):
    if STORE.exists():
        raise RuntimeError("profile_already_configured_no_overwrite")
    base_environment(values)
    private_directory()
    ciphertext = base64.b64encode(protect(json.dumps(values).encode())).decode()
    temp = RUNTIME / ("credentials-" + secrets.token_hex(8) + ".tmp")
    try:
        temp.write_text(json.dumps({"version": 1, "projectRef": REF, "ciphertext": ciphertext}), encoding="utf-8")
        os.link(temp, STORE)  # Atomic create, never replace a concurrently saved profile.
    finally:
        temp.unlink(missing_ok=True)
    emit(status="saved", secretValuesDisplayed=False)

def connection_values(uri, password, secret_key, publishable):
    uri = uri.strip().strip('"')
    u = urlsplit(uri)
    if password:
        netloc = (u.username or "") + ":" + quote(password, safe="") + "@" + (u.hostname or "") + (":" + str(u.port) if u.port else "")
        uri = urlunsplit((u.scheme, netloc, u.path, u.query, ""))
        u = urlsplit(uri)
    elif "YOUR-PASSWORD" in (u.password or "") or "YOUR_PASSWORD" in (u.password or ""):
        raise RuntimeError("database_password_placeholder")
    q = parse_qsl(u.query, keep_blank_values=True)
    if not any(k == "sslmode" for k, _ in q):
        q.append(("sslmode", "require"))
    uri = urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), ""))
    worker_q = [(k, v) for k, v in q if k not in ("schema", "pgbouncer", "connection_limit", "pool_timeout")]
    return {"DATABASE_URL": uri, "DIRECT_URL": uri,
            "WORKER_DATABASE_URL": urlunsplit((u.scheme, u.netloc, u.path, urlencode(worker_q), "")),
            "SUPABASE_SECRET_KEY": secret_key.strip(), "SUPABASE_PUBLISHABLE_KEY": publishable.strip(),
            "INTERNAL_API_KEY": secrets.token_urlsafe(32)}

def configure_gui():
    import tkinter as tk
    from tkinter import ttk, messagebox
    if STORE.exists():
        emit(status="already_saved", secretValuesDisplayed=False)
        return
    window = tk.Tk()
    window.title("Novo Supabase — cadastro protegido")
    window.geometry("690x450")
    window.resizable(False, False)
    frame = ttk.Frame(window, padding=20)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="Projeto de testes: " + REF, font=("Segoe UI", 11, "bold")).pack(anchor="w")
    ttk.Label(frame, text="Cole nos campos abaixo. Os valores ficam ocultos e não serão enviados ao chat.").pack(anchor="w", pady=(6, 14))
    fields = []
    labels = ["URI Session Pooler (Connect → Session pooler, porta 5432)",
              "Senha do banco (preencha se a URI contém [YOUR-PASSWORD]; use a senha original)",
              "Chave secreta do NOVO projeto (sb_secret_...)",
              "Chave publicável do NOVO projeto (sb_publishable_...)"]
    for label in labels:
        ttk.Label(frame, text=label).pack(anchor="w", pady=(4, 2))
        entry = ttk.Entry(frame, show="*", width=90)
        entry.pack(fill="x", pady=(0, 4))
        menu = tk.Menu(entry, tearoff=0)
        menu.add_command(label="Colar", command=lambda e=entry: e.event_generate("<<Paste>>"))
        entry.bind("<Button-3>", lambda event, m=menu: m.tk_popup(event.x_root, event.y_root))
        fields.append(entry)
    ttk.Label(frame, text="Ctrl+V ou botão direito → Colar. SSL é acrescentado se não estiver na URI.").pack(anchor="w", pady=(8, 4))
    def save():
        try:
            values = connection_values(*(entry.get() for entry in fields))
            save_credentials(values)
        except Exception as error:
            messages = {
                "runtime_destination_rejected": "Confira no Connect a URI Session Pooler do projeto indicado, usuário postgres." + REF + " e porta 5432.",
                "new_project_keys_required": "Confira as duas chaves do NOVO projeto: sb_secret_ e sb_publishable_.",
                "database_password_placeholder": "Preencha a senha do banco no segundo campo. Não use o texto [YOUR-PASSWORD] como senha.",
                "profile_already_configured_no_overwrite": "O cadastro já existe e foi preservado.",
            }
            messagebox.showerror("Não foi salvo", messages.get(str(error), "Não foi possível salvar. Nenhum valor foi exibido. Confira os campos e a permissão do Windows."), parent=window)
            return
        for entry in fields:
            entry.delete(0, tk.END)
        messagebox.showinfo("Cadastro concluído", "Salvo com criptografia para seu usuário Windows. Pode avisar que o cadastro foi concluído.", parent=window)
        window.destroy()
    ttk.Button(frame, text="Salvar com segurança", command=save).pack(anchor="e", pady=10)
    fields[0].focus_set()
    window.mainloop()

def configure():
    if STORE.exists():
        raise RuntimeError("profile_already_configured_no_overwrite")
    print("Novo Supabase: " + REF + " (somente testes). Nenhum dado do projeto anterior será lido.")
    print("Cole valores somente nesta janela. Os campos ficam ocultos; não envie pelo chat.")
    uri = getpass.getpass("URI Session Pooler 5432 com sslmode=require: ").strip()
    direct = getpass.getpass("DIRECT_URL (Enter para reutilizar a URI): ").strip() or uri
    worker = getpass.getpass("WORKER_DATABASE_URL (Enter para derivar a URI sem parâmetros Prisma): ").strip()
    if not worker:
        u = urlsplit(uri)
        q = [(k, v) for k, v in parse_qsl(u.query) if k not in ("schema", "pgbouncer", "connection_limit", "pool_timeout")]
        worker = urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), ""))
    values = {"DATABASE_URL": uri, "DIRECT_URL": direct, "WORKER_DATABASE_URL": worker,
              "SUPABASE_SECRET_KEY": getpass.getpass("Chave sb_secret_ do NOVO projeto: ").strip(),
              "SUPABASE_PUBLISHABLE_KEY": getpass.getpass("Chave sb_publishable_ do NOVO projeto: ").strip(),
              "INTERNAL_API_KEY": secrets.token_urlsafe(32)}
    save_credentials(values)

def environment(from_environment=False):
    if from_environment:
        return base_environment({})
    saved = json.loads(STORE.read_text(encoding="utf-8"))
    if saved.get("projectRef") != REF or saved.get("version") != 1:
        raise RuntimeError("protected_store_identity_invalid")
    values = json.loads(protect(base64.b64decode(saved["ciphertext"], validate=True), decrypt=True))
    return base_environment(values)

def connection(env):
    import psycopg
    assert_runtime_destination(env, ("WORKER_DATABASE_URL",))
    return psycopg.connect(env["WORKER_DATABASE_URL"], connect_timeout=15, autocommit=True)

def inventory(env):
    with connection(env) as db:
        db.execute("SET default_transaction_read_only=on")
        tables = [r[0] for r in db.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")]
        initialized = "_prisma_migrations" in tables
        migrations = db.execute('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').fetchone()[0] if initialized else 0
        tasks = db.execute('SELECT id,kind,source,status,"executionHold","createdAt",payload FROM "CollectionTask" WHERE status IN (\'queued\',\'running\') ORDER BY "createdAt"').fetchall() if "CollectionTask" in tables else []
        active = db.execute('SELECT count(*) FROM "WorkerPresence" WHERE "lastSeenAt">now()-interval \'75 seconds\' AND state<>\'stopped\'').fetchone()[0] if "WorkerPresence" in tables else 0
        scheduled = db.execute('SELECT enabled FROM "CatalogWeeklySchedule" WHERE id=1').fetchone() if "CatalogWeeklySchedule" in tables else None
        size = db.execute("SELECT pg_database_size(current_database())").fetchone()[0]
        cluster_size = int(db.execute("SELECT sum(pg_database_size(datname)) FROM pg_database").fetchone()[0])
    return {"status": "connected", "emptyPublicSchema": not tables, "migrationsCompleted": migrations,
            "databaseBytes": size, "clusterDatabaseBytes": cluster_size, "recentWorkers": active, "weeklyEnabled": bool(scheduled and scheduled[0]),
            "tasks": [{"id": r[0], "operation": r[1], "source": r[2], "status": r[3], "held": r[4],
                       "createdAt": r[5].isoformat(), "quantity": r[6].get("quantity", r[6].get("batchSize"))} for r in tasks]}

def migrate(env):
    before = inventory(env)
    if not before["emptyPublicSchema"] and not before["migrationsCompleted"]:
        raise RuntimeError("unexpected_existing_schema_no_changes_applied")
    if before["recentWorkers"] or before["tasks"] or before["weeklyEnabled"]:
        raise RuntimeError("database_not_quiet_no_migration_applied")
    cli = ROOT / "packages/database/node_modules/prisma/build/index.js"
    result = subprocess.run(["node", str(cli), "migrate", "deploy", "--schema",
                             str(ROOT / "packages/database/prisma/schema.prisma")],
                            cwd=ROOT, env=env, capture_output=True)
    if result.returncode:
        raise RuntimeError("migration_failed_provider_output_suppressed")
    emit(operation="migrate", **inventory(env))

def audit(env):
    import httpx
    names = re.findall(r"^model (\w+)", (ROOT / "packages/database/prisma/schema.prisma").read_text(), re.M) + ["_prisma_migrations"]
    with connection(env) as db:
        db.execute("SET default_transaction_read_only=on")
        rows = db.execute("SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(%s)", (names,)).fetchall()
        if len(rows) != len(names) or not all(r[1] for r in rows):
            raise RuntimeError("schema_or_rls_incomplete")
        for role in ("anon", "authenticated"):
            for name in names:
                if db.execute("SELECT has_table_privilege(%s,%s,'SELECT,INSERT,UPDATE,DELETE')", (role, 'public."' + name + '"')).fetchone()[0]:
                    raise RuntimeError("api_table_privileges_not_isolated")
            functions = db.execute("SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('claim_task','claim_selected_task','heartbeat_task','finish_task','catalog_campaign_task_blocked')").fetchall()
            if len(functions) != 5 or any(db.execute("SELECT has_function_privilege(%s,%s::oid,'EXECUTE')", (role, row[0])).fetchone()[0] for row in functions):
                raise RuntimeError("queue_function_privileges_invalid")
        if db.execute("SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND roles && ARRAY['public','anon','authenticated']::name[]").fetchone()[0]:
            raise RuntimeError("unexpected_storage_policy_review_required")
    response = httpx.get(env["SUPABASE_URL"] + "/storage/v1/bucket/race-exports",
                         headers={"apikey": env["SUPABASE_SECRET_KEY"]}, timeout=15, follow_redirects=False)
    if response.status_code != 200:
        raise RuntimeError("storage_key_or_connection_rejected")
    bucket = response.json()
    required = {"application/zip", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
    if bucket.get("public") is not False or bucket.get("file_size_limit") != 52428800 or not required.issubset(set(bucket.get("allowed_mime_types") or [])):
        raise RuntimeError("private_export_bucket_invalid")
    emit(operation="audit", status="passed", tables=len(rows), privateBucket=True, queueRolesDenied=True)

def revision():
    result = subprocess.run(["git", "--git-dir=" + str(ROOT / ".git"), "--work-tree=" + str(ROOT), "rev-parse", "HEAD"],
                            capture_output=True, text=True)
    value = result.stdout.strip()
    if result.returncode or not re.fullmatch("[a-f0-9]{40}", value):
        raise RuntimeError("release_commit_unavailable")
    status = subprocess.run(["git", "--git-dir=" + str(ROOT / ".git"), "--work-tree=" + str(ROOT), "status", "--porcelain"],
                            capture_output=True, text=True)
    return value + ("-dirty" if status.stdout.strip() else "")

def capacity(env, confirmed=False):
    import httpx
    if not confirmed:
        raise RuntimeError("owner_usage_confirmation_required")
    api = "http://127.0.0.1:3000"
    version = httpx.get(api + "/v1/version", timeout=15)
    if version.status_code != 200 or version.json().get("supabaseProjectRef") != REF:
        raise RuntimeError("local_api_identity_mismatch")
    headers = {"X-API-Key": env["INTERNAL_API_KEY"]}
    current = httpx.get(api + "/v1/admin/capacity", headers=headers, timeout=20)
    if current.status_code != 200:
        raise RuntimeError("capacity_read_failed")
    if not current.json().get("confirmedAt"):
        baseline = inventory(env)["clusterDatabaseBytes"]
        mib = 1048576
        payload = {"databaseBudgetBytes": str(baseline + 80 * mib), "storageBudgetBytes": str(32 * mib),
                   "databaseHeadroomBytes": str(16 * mib), "storageHeadroomBytes": str(mib),
                   "allocationConfirmed": True,
                   "reason": "Owner confirmed Usage has at least 128 MiB database and 32 MiB Storage free; bounded local pilot"}
        configured = httpx.post(api + "/v1/admin/capacity/configure", headers={**headers, "Idempotency-Key": "local-profile-initial-capacity"},
                                json=payload, timeout=30)
        if configured.status_code != 200:
            raise RuntimeError("capacity_configuration_failed")
    refreshed = httpx.post(api + "/v1/admin/capacity/refresh", headers={**headers, "Idempotency-Key": "capacity-refresh-" + secrets.token_hex(8)},
                           json={"reason": "Refresh measured usage before bounded local pilot"}, timeout=30)
    if refreshed.status_code != 200:
        raise RuntimeError("capacity_refresh_failed")
    result = refreshed.json()
    if result.get("decisions") != {"database": "allowed", "storage": "allowed"}:
        raise RuntimeError("capacity_not_available")
    result.update(projectRef=REF, ownerUsageConfirmed=True, status="passed", operation="capacity")
    (RUNTIME / "capacity-report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["configure", "configure-gui", "check", "inventory", "migrate", "audit", "capacity", "api", "workers", "browser", "stop", "install-tunnel", "tunnel"])
    parser.add_argument("--from-environment", action="store_true")
    parser.add_argument("--quota-confirmed", action="store_true")
    args = parser.parse_args()
    if args.action == "configure":
        configure(); return
    if args.action == "configure-gui":
        configure_gui(); return
    env = environment(args.from_environment)
    if args.action in ("install-tunnel", "tunnel"):
        import runpy
        private_directory()
        module = runpy.run_path(str(ROOT / "scripts/local-tunnel.py"))
        module["run"](RUNTIME, REF, install_only=args.action == "install-tunnel")
        return
    if args.action in ("check", "inventory"):
        emit(operation=args.action, **inventory(env)); return
    if args.action == "migrate":
        migrate(env); return
    if args.action == "audit":
        audit(env); return
    if args.action == "capacity":
        capacity(env, args.quota_confirmed); return
    if args.action == "stop":
        private_directory()
        (RUNTIME / "executors").mkdir(exist_ok=True)
        (RUNTIME / "executors" / "stop").touch()
        emit(status="worker_stop_requested"); return
    env.update(GIT_SHA=revision(), WORKER_CODE_VERSION=revision())
    if args.action == "browser":
        command = [sys.executable, str(ROOT / "apps/openresults-worker/browser_smoke.py")]
    elif args.action == "api":
        command = ["node", str(ROOT / "apps/api/dist/apps/api/src/server.js")]
    else:
        state = inventory(env)
        emit(operation="preflight", **state)
        if state["weeklyEnabled"] or state["recentWorkers"]:
            raise RuntimeError("unexpected_schedule_or_executor")
        command = [sys.executable, "-u", str(ROOT / "scripts/local-executors.py")]
    raise SystemExit(subprocess.call(command, cwd=ROOT, env=env))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        emit(status="stopped")
    except Exception as error:
        known = str(error)
        safe = known if re.fullmatch("[a-z_]{3,100}", known) else "local_staging_operation_failed"
        emit(status="failed", error=safe, secretValuesDisplayed=False)
        raise SystemExit(1)
