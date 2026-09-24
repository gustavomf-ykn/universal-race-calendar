"""Exports use persisted selections, Portuguese reference columns and bounded parts."""
import io
import json
import zipfile
from datetime import date, datetime
from app.models import EXPORT_COLUMNS
from app.services.exporter import _styled_workbook

SIMPLE=[('internal_id','ID interno'),('event_id','ID na fonte'),('name','Nome'),('event_date','Data'),('city','Cidade'),('state','UF'),('source','Fonte'),('url','URL de origem'),('publication','Publicação')]
FULL=SIMPLE+[('description','Descrição'),('location','Local'),('address','Endereço'),('modality','Modalidade'),('registration','Inscrição'),('official','Site oficial'),('image','Imagem'),('references','Referências de fontes'),('updated_at','Atualizado em'),('metadata_json','Metadados completos (JSON)')]
PART_ROWS=25000
MAX_BYTES=50*1024*1024

def excel_file(rows,columns):
    # The original exporter converts timezone-aware dates only when given ISO strings.
    normalized=[{k:v.isoformat() if isinstance(v,(date,datetime)) else v for k,v in row.items()} for row in rows]
    book=_styled_workbook(normalized,columns,sheet_name='Resultados' if columns==EXPORT_COLUMNS else 'Provas',table_name='Dados')
    output=io.BytesIO();book.save(output);book.close();return output.getvalue()

def build_selection(artifact,connection):
    selection=artifact['selection'];ids=selection['eventIds'];kind=artifact['kind'];files=[];total=0
    if not ids or len(ids)>10000: raise ValueError('invalid_selection')
    with connection() as conn:
        events=conn.execute('SELECT * FROM "Event" WHERE id=ANY(%s) ORDER BY id',(ids,)).fetchall()
        if len(events)!=len(ids):raise ValueError('selection_changed')
        if not selection.get('administrative') and any(e['publicationStatus']!='published' for e in events):raise ValueError('event_not_published')
        if kind!='results':
            rows=[]
            for e in events:
                refs=conn.execute('SELECT "sourceType","sourceExternalId",url FROM "EventSourceReference" WHERE "eventId"=%s ORDER BY "sourceType"',(e['id'],)).fetchall()
                children={}
                for table in ('EventDistance','EventPrice','EventKit','EventKitPickup','EventSchedule','EventRule','EventImage'):
                    children[table]=conn.execute(f'SELECT * FROM "{table}" WHERE "eventId"=%s',(e['id'],)).fetchall()
                rows.append(dict(metadata_json=json.dumps({**e,'references':refs,**children},ensure_ascii=False,default=str),internal_id=e['id'],event_id=e['sourceExternalId'],name=e['name'],event_date=e['date'],city=e['city'],state=e['state'],source=e['sourceType'],url=e['sourceUrl'],publication=e['publicationStatus'],description=e['description'],location=e['locationName'],address=e['address'],modality=e['modality'],registration=e['registrationUrl'],official=e['officialUrl'],image=e['mainImageUrl'],references=json.dumps(refs,ensure_ascii=False),updated_at=e['updatedAt']))
            files=[('provas.xlsx',excel_file(rows,SIMPLE if kind=='catalog-simple' else FULL))];total=len(rows)
        else:
            group=[];part=0
            def flush(prefix):
                nonlocal group,part
                if group:
                    part+=1;files.append((f'{prefix}-{part}.xlsx',excel_file(group,EXPORT_COLUMNS)));group=[]
            for e in events:
                count=0
                with conn.cursor(name='results_export') as cur:
                    cur.execute('SELECT r.*,s."externalId",s."sourceUrl",s."updatedAt" FROM "RaceResult" r JOIN "ResultSet" s ON s.id=r."resultSetId" WHERE s."eventId"=%s ORDER BY s.id,r.id',(e['id'],))
                    for r in cur:
                        count+=1;total+=1
                        group.append(dict(event_id=r['externalId'],event=e['name'],event_date=e['date'],city=e['city'],state=e['state'],modality=r['modality'],distance_km=r['distanceKm'],gender=r['gender'],overall_position=r['overallPosition'],category_position=r['categoryPosition'],category=r['category'],bib=r['bib'],name=r['name'],team=r['team'],pace=r['pace'],time=r['time'],gap=r['gap'],source_url=r['sourceUrl'],extracted_at=r['updatedAt']))
                        if len(group)>=PART_ROWS:flush(e['id'] if selection.get('layout')=='individual' else 'resultados')
                        if sum(len(data) for _,data in files)>MAX_BYTES:raise ValueError('export_too_large_refine_selection')
                if not count:raise ValueError('selected_edition_without_results')
                if selection.get('layout')=='individual':flush(e['id'])
            flush('resultados')
    if any(len(data)>MAX_BYTES for _,data in files):raise ValueError('export_too_large_refine_selection')
    if len(files)==1:return io.BytesIO(files[0][1]),'xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',total
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,data in files:archive.writestr(name,data)
    if output.tell()>MAX_BYTES:raise ValueError('export_too_large_refine_selection')
    return output,'zip','application/zip',total
