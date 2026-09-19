"""Read-only audit for the explicitly identified staging project. No row data or secrets are emitted."""
import json,os,re,sys
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit,parse_qsl,urlencode
import psycopg
from psycopg.rows import dict_row

try:
    ref=sys.argv[1]
    assert ref=='sggrijhyblejlgimgzzc' and os.environ['SUPABASE_URL']==f'https://{ref}.supabase.co'
    uri=urlsplit(os.environ['DIRECT_URL'])
    query=urlencode([(k,v) for k,v in parse_qsl(uri.query) if k!='schema'])
    uri=urlunsplit((uri.scheme,uri.netloc,uri.path,query,''))
    names=re.findall(r'^model (\w+)',Path('packages/database/prisma/schema.prisma').read_text(),re.M)+['_prisma_migrations']
    with psycopg.connect(uri,row_factory=dict_row) as conn:
        conn.execute('SET TRANSACTION READ ONLY')
        rows=conn.execute('SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=\'public\' AND c.relname=ANY(%s)',(names,)).fetchall()
        assert len(rows)==len(names) and all(row['relrowsecurity'] for row in rows)
        for role in ['anon','authenticated']:
            for name in names:
                assert not conn.execute('SELECT has_table_privilege(%s,%s,\'SELECT,INSERT,UPDATE,DELETE\') AS granted',(role,f'public."{name}"')).fetchone()['granted']
            for function in ['claim_task(text[],text)','heartbeat_task(text,text,jsonb)','finish_task(text,text,text,jsonb,text)']:
                assert not conn.execute('SELECT has_function_privilege(%s,%s,\'EXECUTE\') AS granted',(role,'public.'+function)).fetchone()['granted']
        bucket=conn.execute("SELECT public,file_size_limit FROM storage.buckets WHERE id='race-exports'").fetchone()
        assert bucket and not bucket['public'] and bucket['file_size_limit']==52428800
        policies=conn.execute("SELECT count(*) AS count FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND roles && ARRAY['public','anon','authenticated']::name[]").fetchone()['count']
        migrations=conn.execute('SELECT count(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').fetchone()['count']
    print(json.dumps({'projectRef':ref,'status':'passed' if policies==0 else 'policy_review_required','tablesChecked':len(names),'migrations':migrations,'privateBucket':True,'apiRolesDenied':True,'storagePoliciesRequiringReview':policies}))
except Exception:
    print(json.dumps({'status':'failed','error':'staging_audit_failed','details':'Check connection, completed migrations, table privileges/RLS and private bucket; no credentials or row data were logged.'}))
    sys.exit(1)
