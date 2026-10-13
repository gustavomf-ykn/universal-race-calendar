"""Check only public OCI revision labels, never container environment."""
import subprocess,sys
from preflight import release

def verify(values,scope,inspect):
 names=['API_IMAGE']+(['RESULTS_IMAGE'] if scope=='workers' else [])
 if scope not in ('api','workers'):raise ValueError()
 for name in names:
  if inspect(values[name])!=values['RELEASE_SHA']:raise ValueError()

def inspect_revision(image):
 r=subprocess.run(['docker','image','inspect','--format',
  '{{index .Config.Labels "org.opencontainers.image.revision"}}',image],
  check=True,capture_output=True,text=True)
 return r.stdout.strip()

if __name__=='__main__':
 try:
  verify(release(sys.argv[1]),sys.argv[2],inspect_revision)
  print('immutable_image_commit_passed')
 except Exception:raise SystemExit('immutable_image_commit_unconfirmed; deployment stopped')
