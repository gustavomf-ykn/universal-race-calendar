"""Test-only executor fixture. Not copied into the worker image."""
import asyncio
import sys
from datetime import date,datetime,timezone
from unittest.mock import patch

from app.models import EventMetadata,ExtractionResult,ModalityInfo
import worker

mode=sys.argv[1]
if mode=='privileges':
    from pathlib import Path
    with worker.connection() as conn:
        for role in ['anon','authenticated']:
            conn.execute(f"DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='{role}') THEN CREATE ROLE {role}; END IF; END $$")
            conn.execute(f'GRANT EXECUTE ON FUNCTION claim_task(text[],text) TO {role}')
            conn.execute(f'GRANT SELECT ON "_prisma_migrations" TO {role}')
        conn.execute(Path('../../packages/database/prisma/migrations/20260919000000_staging_privileges/migration.sql').read_text())
        for role in ['anon','authenticated']:
            assert not conn.execute("SELECT has_function_privilege(%s,'claim_task(text[],text)','EXECUTE') AS allowed",(role,)).fetchone()['allowed']
            assert not conn.execute("SELECT has_table_privilege(%s,'\"_prisma_migrations\"','SELECT') AS allowed",(role,)).fetchone()['allowed']
    print('explicit_api_privileges_revoked')
    sys.exit(0)
if mode=="cleanup":
    asyncio.run(worker.cleanup_exports())
    sys.exit(0)
task=worker.query('SELECT * FROM claim_task(%s,%s)',([sys.argv[2]],'fixture-'+sys.argv[3]),one=True)
assert task and task['id']==sys.argv[3], 'unexpected_claim'

def metadata():
    return EventMetadata('Meia Maratona de Florianopolis',date(2026,8,16),'Florianopolis','SC',
                         'https://openresults.run/evento/fixture/','fixture',expected_total=1,event_id='fixture-openresults')

async def fetch(self,url):
    return metadata(),[ModalityInfo('5 km','5')]

async def scrape(self,url,progress):
    await progress('fixture',50)
    if mode=='pause':
        print('fixture_claimed',flush=True)
        await asyncio.sleep(600)
    if mode=='fail':
        raise RuntimeError('fixture upstream failure')
    return ExtractionResult(metadata(),[ModalityInfo('5 km','5')],
        [{'name':'Fixture Runner','bib':'007','modality':'5 km','gender':'feminino','overall_position':1,'category_position':1,
          'category':'F3039','time':'00:25:00','pace':'05:00','team':''}],1,1,{'F':1},{'5 km | feminino':1},
        warnings=['fixture incomplete'] if mode=='partial' else [],extracted_at=datetime.now(timezone.utc))

with patch.object(worker.EventMetadataService,'fetch',fetch),patch.object(worker.OpenResultsScraper,'scrape',scrape):
    asyncio.run(worker.execute(task))
print('fixture_task_finished')
