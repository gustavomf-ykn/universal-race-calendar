import os,time,subprocess,sys,json
from pathlib import Path
import psycopg
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
root=Path.cwd(); parsed=urlsplit(os.environ['DATABASE_URL'])
assert parsed.hostname in ['localhost','127.0.0.1','postgres'] and parsed.path.endswith('_test'), 'isolated database required'
url=urlunsplit(parsed._replace(query=urlencode([(k,v) for k,v in parse_qsl(parsed.query) if k!='schema'])))
env=dict(os.environ,DATABASE_URL=url,DIRECT_URL=url,WORKER_DATABASE_URL=url,WORKER_CODE_VERSION='isolated-operations-test')
for key in ['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY']:env.pop(key,None)
stop=root/'.secrets/executors/stop'
process=None
try:
 for cycle in range(2):
  process=subprocess.Popen([sys.executable,'scripts/local-executors.py'],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  deadline=time.monotonic()+45
  while time.monotonic()<deadline:
   with psycopg.connect(url) as db: rows=db.execute('SELECT runtime,state,"lastSeenAt" FROM "WorkerPresence" WHERE state=\'available\' AND "lastSeenAt">now()-interval \'25 seconds\'').fetchall()
   if len(rows)==2:break
   assert process.poll() is None,'supervisor_stopped'
   time.sleep(1)
  assert {r[0] for r in rows}=={'typescript','python'}
  if cycle==0:
   duplicate=subprocess.run([sys.executable,'scripts/local-executors.py'],env=env,capture_output=True,timeout=10)
   assert duplicate.returncode==2
   first={r[0]:r[2] for r in rows};time.sleep(22)
   with psycopg.connect(url) as db: current=db.execute('SELECT runtime,"lastSeenAt" FROM "WorkerPresence" WHERE state=\'available\'').fetchall()
   assert all(t>first[r] for r,t in current)
  stop.touch();process.wait(timeout=15);assert process.returncode==0
  with psycopg.connect(url) as db: assert db.execute('SELECT count(*) FROM "WorkerPresence" WHERE state IN (\'available\',\'busy\')').fetchone()[0]==0
  print(json.dumps({'cycle':cycle+1,'bothIdlePresent':True,'gracefulStop':True,'duplicateRejected':cycle==0,'idleHeartbeatAdvanced':cycle==0}),flush=True)
finally:
 if process and process.poll() is None:stop.touch();process.wait(timeout=20)
