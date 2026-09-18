"""Exercise dry-run and repeated apply against synthetic SQLite and isolated Postgres."""
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from migrate_sqlite import main
from worker import query

with tempfile.TemporaryDirectory(prefix='race-migration-') as tmp:
    root=Path(tmp);db=root/'old.sqlite';mapping=root/'mapping.json';report=root/'report.json'
    with sqlite3.connect(db) as conn:
        conn.executescript('''CREATE TABLE catalog_events(catalog_id INTEGER,event_id TEXT,name TEXT,start_date TEXT,city TEXT,state TEXT,event_url TEXT,event_slug TEXT,expected_total INTEGER);
        CREATE TABLE jobs(id TEXT,status TEXT,updated_at TEXT);
        CREATE TABLE job_events(job_id TEXT,event_id TEXT,status TEXT);
        CREATE TABLE athlete_results(row_id INTEGER,event_id TEXT,job_id TEXT,data_json TEXT);''')
        conn.execute('INSERT INTO catalog_events VALUES (1,?,?,?,?,?,?,?,1)',('fixture-openresults','Meia Maratona de Florianopolis','2026-08-16','Florianopolis','SC','https://openresults.run/evento/fixture/','fixture'))
        conn.execute("INSERT INTO jobs VALUES ('completed','completed','2026-09-18')")
        conn.execute("INSERT INTO job_events VALUES ('completed','fixture-openresults','completed')")
        conn.execute("INSERT INTO athlete_results VALUES (1,'fixture-openresults','completed',?)",(json.dumps({'name':'Fixture Runner','bib':'007','modality':'5 km','gender':'feminino','overall_position':1}),))
    conn.close()
    mapping.write_text(json.dumps({'fixture-openresults':sys.argv[1]}))
    before=db.read_bytes()
    args=['migrate_sqlite.py',str(db),'--mapping',str(mapping),'--report',str(report)]
    with patch.object(sys,'argv',args):main()
    assert json.loads(report.read_text())[0]['status']=='planned'
    ids=[]
    for _ in range(2):
        with patch.object(sys,'argv',args+['--apply']):main()
        item=json.loads(report.read_text())[0]
        assert item['status']=='verified' and item['verifiedRows']==1
        ids.append(item['resultSetId'])
    assert ids[0]==ids[1] and db.read_bytes()==before
print('migration_fixture_verified')
