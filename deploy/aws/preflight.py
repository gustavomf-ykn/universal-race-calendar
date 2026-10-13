"""Local/host configuration verification; never dumps environment values."""
import ipaddress, os, re, sys
from pathlib import Path
from urllib.parse import urlparse,parse_qs

def release(path):
 values={}
 for line in Path(path).read_text().splitlines():
  if line and not line.startswith('#'):
   name, value=line.split('=',1); values[name]=value
 host=values.get('API_PUBLIC_HOST','')
 if not re.fullmatch(r'(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',host) or '.' not in host or 'YOUR' in host.upper():
  raise ValueError()
 try:ipaddress.ip_address(host);raise ValueError()
 except ValueError as e:
  if str(e)=='':raise
 if host.endswith(('.onrender.com','.lovable.app','.amazonaws.com')):raise ValueError()
 if not re.fullmatch('[a-f0-9]{40}',values.get('RELEASE_SHA','')):raise ValueError()
 for name, package in [('API_IMAGE','runfinder-api'),('RESULTS_IMAGE','runfinder-results')]:
  if not re.fullmatch('ghcr.io/gustavomf-ykn/'+package+'@sha256:[a-f0-9]{64}',values.get(name,'')):raise ValueError()
 if not re.fullmatch(r'caddy@sha256:[a-f0-9]{64}',values.get('CADDY_IMAGE','')):raise ValueError()
 return values

def secrets(directory):
 groups={'api':['DATABASE_URL','SUPABASE_URL','SUPABASE_SECRET_KEY','INTERNAL_API_KEY','CORS_ORIGINS'],
 'calendar':['DATABASE_URL','SUPABASE_URL'],'results':['WORKER_DATABASE_URL','SUPABASE_URL','SUPABASE_SECRET_KEY'],
 'migration':['DATABASE_URL','DIRECT_URL','SUPABASE_URL']}
 for group,names in groups.items():
  path=Path(directory)/(group+'.env')
  if os.name!='nt' and path.stat().st_mode&0o077:raise ValueError()
  v=dict(line.split('=',1) for line in path.read_text().splitlines() if line and not line.startswith('#'))
  if any(not v.get(n) for n in names) or v.get('SUPABASE_URL')!='https://sggrijhyblejlgimgzzc.supabase.co':raise ValueError()
  for n in ('DATABASE_URL','DIRECT_URL','WORKER_DATABASE_URL'):
   if n not in v:continue
   uri=urlparse(v[n]); ref='sggrijhyblejlgimgzzc'
   direct=uri.hostname=='db.'+ref+'.supabase.co' and uri.username=='postgres'
   pool=bool(uri.hostname and uri.hostname.endswith('.pooler.supabase.com') and uri.username=='postgres.'+ref)
   q=parse_qs(uri.query)
   if not(direct or pool) or uri.port not in (None,5432) or uri.path!='/postgres' or not uri.password or q.get('sslmode') not in (['require'],['verify-full']):raise ValueError()
   if n=='WORKER_DATABASE_URL' and any(x in q for x in ('schema','pgbouncer','connection_limit','pool_timeout')):raise ValueError()
  if group=='api':
   if len(v['INTERNAL_API_KEY'])<32:raise ValueError()
   origins=v['CORS_ORIGINS'].split(',')
   if not all(urlparse(o).scheme=='https' and urlparse(o).netloc and not urlparse(o).path for o in origins):raise ValueError()

if __name__=='__main__':
 try:
  release(sys.argv[1]); secrets(sys.argv[2] if len(sys.argv)>2 else '/etc/runfinder/staging')
  print('aws_staging_configuration_passed')
 except Exception:raise SystemExit('aws_staging_configuration_unconfirmed; no values emitted')
