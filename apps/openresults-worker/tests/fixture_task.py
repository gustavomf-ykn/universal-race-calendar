"""Test-only executor fixture. Not copied into the worker image."""
import asyncio
import sys
from datetime import date,datetime,timezone
from unittest.mock import patch

from app.models import EventMetadata,ExtractionResult,ModalityInfo
import worker

mode=sys.argv[1]
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
