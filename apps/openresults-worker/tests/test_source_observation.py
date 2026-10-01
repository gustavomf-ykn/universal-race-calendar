from datetime import date
from app.models import EventMetadata
from source_observation import edition_observation

def test_whitelisted_edition_evidence_preserves_dates_and_does_not_infer_modality_from_name():
    metadata=EventMetadata(name='Mountain Race',event_date=date(2026,10,1),city='Garuva',state='SC',
        source_url='https://openresults.run/evento/race/',slug='race',raw_metadata={'secret':'private'},event_type='')
    observation=edition_observation(metadata)
    assert observation['date']=='2026-10-01'
    assert observation['modality'] is None
    assert 'secret' not in str(observation)
    metadata.event_type='Corrida de montanha'
    assert edition_observation(metadata)['modality']=='trail'
