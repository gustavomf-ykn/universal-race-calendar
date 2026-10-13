"""CI-only Caddy smoke: isolated container, fake credentials, no upstream/network."""
import json,subprocess,time
from pathlib import Path
root=Path(__file__).resolve().parents[1]

def check(*args):
 return subprocess.run(args,check=True,capture_output=True,text=True).stdout.strip()

def main():
 container=None
 try:
  check('docker','pull','caddy:2')
  container=check('docker','run','-d','--network','none','--read-only','--memory','256m',
   '--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges:true','--tmpfs','/data:size=64m','--tmpfs','/config:size=16m',
   '--tmpfs','/tmp:size=16m','-e','API_PUBLIC_HOST=http://:8080',
   '-v',str(root/'deploy/aws/Caddyfile')+':/etc/caddy/Caddyfile:ro','caddy:2')
  sentinel='caddy-sensitive-fixture-never-log'
  records=[]
  for _ in range(20):
   response=subprocess.run(['docker','exec',container,'wget','-q','-O','/dev/null',
    '--header=Authorization: Bearer '+sentinel,'--header=X-Api-Key: '+sentinel,
    '--header=X-Internal-Api-Key: '+sentinel,
    'http://127.0.0.1:8080/?token='+sentinel],capture_output=True,timeout=5)
   log=subprocess.run(['docker','logs',container],check=True,capture_output=True,text=True)
   text=log.stdout+log.stderr
   if sentinel in text:raise ValueError()
   records=[]
   for line in text.splitlines():
    try:records.append(json.loads(line))
    except ValueError:continue
   if any(str(r.get('logger','')).startswith('http.log.error') for r in records):break
   time.sleep(0.2)
  errors=[r for r in records if str(r.get('logger','')).startswith('http.log.error')]
  print(json.dumps({'running':check('docker','inspect','--format','{{.State.Running}}',container)=='true',
   'requestCommandExit':response.returncode,'errorRecords':len(errors),
   'headersRetained':any('headers' in r.get('request',{}) for r in errors),
   'uriRetained':any('uri' in r.get('request',{}) for r in errors),
   'configParseError':any('adapting config' in line or 'parsing caddyfile' in line for line in text.splitlines())}))
  if not errors or any('headers' in r.get('request',{}) or 'uri' in r.get('request',{}) for r in errors):
   raise ValueError()
  digest=check('docker','image','inspect','--format','{{index .RepoDigests 0}}','caddy:2')
  print('caddy_runtime_error_redaction_passed')
  print('Tested CADDY_IMAGE='+digest)
 finally:
  if container:subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('caddy_runtime_validation_failed; no credentials or request data emitted')
