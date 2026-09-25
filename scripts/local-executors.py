"""One foreground supervisor. No scheduler, service or Windows startup registration."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

import psycopg

ROOT = Path(__file__).resolve().parents[1]


def main():
    runtime = ROOT / '.secrets' / 'executors'
    runtime.mkdir(parents=True, exist_ok=True)
    lock = (runtime / 'session.lock').open('a+b')
    lock.seek(0); lock.write(b'1'); lock.flush(); lock.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print('Já existe um inicializador ativo nesta pasta. Use a janela existente.', flush=True)
        return 2
    stop = runtime / 'stop'
    children = []
    database_guard = None
    output_lock = threading.Lock()
    def log(message):
        with output_lock:
            line = f'{datetime.now(timezone.utc).isoformat()} {message}'
            print(line, flush=True)
            with (runtime / 'operations.log').open('a', encoding='utf-8') as out:
                out.write(line + '\n')
    try:
        # No migration or enqueue. Fail before starting either consumer.
        database_guard = psycopg.connect(os.environ['WORKER_DATABASE_URL'], connect_timeout=15, autocommit=True)
        with database_guard.cursor():
            db = database_guard
            if not db.execute("SELECT pg_try_advisory_lock(72122026)").fetchone()[0]:
                log('Outro inicializador já controla este banco. Nenhum executor iniciado.'); return 2
            selection_file = os.environ.get('WORKER_TASK_SELECTION_FILE')
            selected = None
            if selection_file:
                selected = json.loads(Path(selection_file).read_text(encoding='utf-8'))
                if not isinstance(selected, list) or len(selected)>100 or any(not isinstance(i,str) or not i or len(i)>100 for i in selected):
                    raise ValueError('task_selection_invalid')
            db.execute('SELECT id FROM "WorkerPresence" LIMIT 0')
            db.execute('SELECT id FROM "CatalogSync" LIMIT 0')
            db.execute('SELECT id FROM "AdminAudit" LIMIT 0')
            db.execute('SELECT "administrativeReview" FROM "Event" LIMIT 0')
            db.execute('SELECT "distanceKm",gap FROM "RaceResult" LIMIT 0')
            db.execute('SELECT selection,"contentType" FROM "ExportArtifact" LIMIT 0')
            active = db.execute('SELECT count(*) FROM "WorkerPresence" WHERE "lastSeenAt">now()-interval \'75 seconds\' AND state<>\'stopped\'').fetchone()[0]
            protected = db.execute('SELECT count(*) FROM "CollectionTask" WHERE status=\'queued\' AND "executionHold"').fetchone()[0]
            pending = db.execute('SELECT id,kind,source,payload FROM "CollectionTask" WHERE NOT "executionHold" AND (%s::text[] IS NULL OR id=ANY(%s::text[])) AND (status=\'queued\' OR (status=\'running\' AND "leaseUntil"<=now())) ORDER BY "createdAt"', (selected,selected)).fetchall()
            running = db.execute('SELECT count(*) FROM "CollectionTask" WHERE status=\'running\' AND \"leaseUntil\">now()').fetchone()[0]
        if active or running:
            log('Outro executor recente ou tarefa em execução detectada. Não iniciamos concorrentes; confira o painel e aguarde a presença expirar.')
            return 2
        log(f'Conexão aprovada. {len(pending)} pedidos elegíveis; {protected} pedidos protegidos; nenhum executor recente.')
        if selected is not None:
            log('Modo seletivo: somente IDs do arquivo informado poderão ser adquiridos.')
        for tid, kind, source, payload in pending:
            log(f'Pedido {tid}: {kind}/{source}; quantidade={payload.get("quantity", payload.get("batchSize", "não aplicável"))}.')
        if pending and input('Iniciar e consumir esses pedidos? Digite INICIAR: ').strip() != 'INICIAR':
            log('Início cancelado. Nenhum pedido foi alterado.'); return 0
        stop.unlink(missing_ok=True)
        env = dict(os.environ, WORKER_MODE='continuous', WORKER_STOP_FILE=str(stop))
        env.pop('WORKER_REPORT_PATH', None)
        commands = [
            ('Calendário', ['node', str(ROOT/'apps/worker/dist/apps/worker/src/queue.js')], ROOT),
            ('Resultados e planilhas', [sys.executable, '-u', '-m', 'worker'], ROOT/'apps/openresults-worker'),
        ]
        def drain(label, stream):
            for line in stream:
                line = line.strip()
                # Only explicit operational messages; never arbitrary source or exception output.
                if line.startswith(('Calendar executor ', 'Calendar task ', 'Calendar:', 'Results executor ', 'Results task ', 'Results:', 'Worker stopped;', 'Export cleanup pending;')):
                    log(f'{label}: {line}')
        for label, cmd, cwd in commands:
            child = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, encoding='utf-8', errors='replace',
                                     creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' else 0)
            children.append(child)
            threading.Thread(target=drain, args=(label,child.stdout), daemon=True).start()
        log('Executores iniciados. Use o painel; mantenha esta janela aberta. Ctrl+C encerra após a tarefa atual.')
        while all(c.poll() is None for c in children):
            if stop.exists():
                log('Parada solicitada; aguardando as tarefas atuais.')
                return 0
            time.sleep(1)
        if stop.exists():
            return 0
        log('Um executor terminou. Encerrando o conjunto; confira a conexão, a migration e o histórico no painel.')
        return 1
    except KeyboardInterrupt:
        log('Parada solicitada: não serão adquiridas novas tarefas; aguardando a tarefa atual.')
        return 0
    except Exception:
        log('Não foi possível iniciar: confira credenciais protegidas, conexão e migrations operacionais. Nenhum segredo foi registrado.')
        return 1
    finally:
        if children:
            stop.touch()
        for child in children:
            try:
                child.wait()
            except KeyboardInterrupt:
                log('Parada forçada solicitada. Trabalho interrompido poderá exigir recuperação por lease.')
                child.terminate(); child.wait()
        if database_guard:
            database_guard.close()
        lock.close()


if __name__ == '__main__':
    raise SystemExit(main())
