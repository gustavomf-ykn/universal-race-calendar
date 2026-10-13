"""Own-container liveness, updated only after database heartbeat succeeds."""
import json, os, time
from pathlib import Path
def write_health(state):
 value=os.environ.get('WORKER_HEALTH_FILE')
 if not value:return
 path=Path(value);temporary=path.with_name(path.name+'.tmp')
 temporary.write_text(json.dumps({'state':state,'updatedAt':time.time()}))
 temporary.chmod(0o600);temporary.replace(path)
def healthy(path,now=None):
 data=json.loads(Path(path).read_text())
 age=(time.time() if now is None else now)-data['updatedAt']
 return data['state'] in ('available','busy','resource_wait') and -5<=age<=60
if __name__=='__main__':
 try:raise SystemExit(0 if healthy(os.environ['WORKER_HEALTH_FILE']) else 1)
 except (OSError,KeyError,ValueError,TypeError):raise SystemExit(1)
