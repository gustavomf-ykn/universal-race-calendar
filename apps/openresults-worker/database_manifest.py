"""Read-only calendar migration verification: counts, relationship checks, sampled hashes."""
import hashlib
import json
import os
import psycopg
from psycopg import sql
from psycopg.rows import dict_row

TABLES=['Source','Event','EventSourceReference','EventDistance','EventPrice','EventKit','EventKitPickup','EventSchedule','EventRule','EventImage','EventVersion','RawSourceExtraction','ExtractionJob','CurationJob','ImportRun','ImportCandidate']

def manifest(url):
    with psycopg.connect(url,row_factory=dict_row) as conn:
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        tables={}
        for table in TABLES:
            count=conn.execute(sql.SQL('SELECT count(*) AS count FROM {}').format(sql.Identifier(table))).fetchone()['count']
            samples=conn.execute(sql.SQL('SELECT * FROM {} ORDER BY id LIMIT 20').format(sql.Identifier(table))).fetchall()
            tables[table]={'count':count,'sampleHash':hashlib.sha256(json.dumps(samples,default=str,sort_keys=True).encode()).hexdigest()}
        orphaned=conn.execute('''SELECT count(*) AS count FROM "EventSourceReference" r
            LEFT JOIN "Event" e ON e.id=r."eventId" LEFT JOIN "Source" s ON s.id=r."sourceId" WHERE e.id IS NULL OR s.id IS NULL''').fetchone()['count']
        return {'tables':tables,'orphanedReferences':orphaned}

if __name__=='__main__':
    print(json.dumps(manifest(os.environ['MANIFEST_DATABASE_URL']),indent=2))
