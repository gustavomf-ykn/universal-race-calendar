"""AWS artifact is limited to the confirmed staging project before any connection."""
import os
from urllib.parse import urlparse,parse_qs
def assert_aws_staging():
 if os.environ.get('HOSTING_TARGET')!='aws':return
 try:
  ref='sggrijhyblejlgimgzzc';u=urlparse(os.environ['WORKER_DATABASE_URL']);q=parse_qs(u.query)
  direct=u.hostname=='db.'+ref+'.supabase.co' and u.username=='postgres'
  pool=bool(u.hostname and u.hostname.endswith('.pooler.supabase.com') and u.username=='postgres.'+ref)
  if os.environ['SUPABASE_URL']!='https://'+ref+'.supabase.co' or u.scheme not in ('postgres','postgresql') or not (direct or pool) or not u.password or u.path!='/postgres' or u.port not in (None,5432) or q.get('sslmode') not in (['require'],['verify-full']):raise ValueError()
  if any(k in q for k in ('schema','pgbouncer','connection_limit','pool_timeout')):raise ValueError()
 except Exception:raise RuntimeError('aws_staging_configuration_rejected') from None
