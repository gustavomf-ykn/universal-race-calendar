from datetime import date, datetime, timezone
import pytest
from app.models import EventDiscovery, EventMetadata, ModalityInfo, StructureChangedError
from app.services.result_pages import parse_result_page


@pytest.fixture
def result_page():
    metadata = EventMetadata('Teste', date(2026,1,1),'Teste','SC','https://openresults.run/evento/teste/','teste',event_id='123')
    modality = ModalityInfo('5k','5k',{'F':1})
    discovery = EventDiscovery(metadata,[modality],'https://openresults.run/ajax_resultados_evento.cfm?id_evento=123',
        ['Geral','Cat.','Número','Nome','Equipe','Pace','Tempo','Gap'])
    payload = {'ok':True,'recordsTotal':1,'recordsFiltered':1,'nextOffset':1,'hasMore':'false',
        'html':'<tr><td>1</td><td>F18</td><td>001</td><td>Fixture</td><td></td><td>05:00</td><td>00:25:00</td><td></td></tr>'}
    return discovery, modality, payload


def parse(fixture):
    discovery, modality, payload = fixture
    return parse_result_page(payload, discovery, modality, 'F', 0, datetime.now(timezone.utc))


def test_false_string_is_terminal_and_missing_flag_requires_total(result_page):
    assert parse(result_page).has_more is False
    del result_page[2]['hasMore']
    assert parse(result_page).has_more is False
    del result_page[2]['recordsTotal']; del result_page[2]['recordsFiltered']
    with pytest.raises(StructureChangedError,match='result_end_unconfirmed'):
        parse(result_page)


@pytest.mark.parametrize('field,value',[
    ('recordsTotal',1.5),('recordsTotal','1.5'),('recordsTotal',True),('recordsTotal',-1),
    ('recordsTotal','Infinity'),('hasMore','maybe'),('hasMore',1),('html',None),
    ('nextOffset',2),('nextOffset','1.5'),('ok','false'),('recordsFiltered',2),('hasMore',True),
])
def test_inconsistent_page_never_becomes_complete(result_page,field,value):
    result_page[2][field]=value
    with pytest.raises(StructureChangedError):
        parse(result_page)


def test_empty_page_with_more_is_not_a_valid_end(result_page):
    result_page[2].update(html='',nextOffset=0,hasMore=True)
    with pytest.raises(StructureChangedError,match='result_pagination_not_advancing'):
        parse(result_page)
