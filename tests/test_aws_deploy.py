"""Offline config/secret handling tests; no AWS clients, source requests or staging DB."""
import importlib.util,json,subprocess,sys
from pathlib import Path
import pytest,yaml
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('aws_preflight',root/'deploy/aws/preflight.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def config(tmp_path):
 p=tmp_path/'release.env'
 p.write_text('API_PUBLIC_HOST=api.example.com\nRELEASE_SHA='+'a'*40+'\nAPI_IMAGE=ghcr.io/gustavomf-ykn/runfinder-api@sha256:'+'b'*64+
  '\nRESULTS_IMAGE=ghcr.io/gustavomf-ykn/runfinder-results@sha256:'+'c'*64+'\nCADDY_IMAGE=caddy@sha256:'+'d'*64+'\n')
 return p
def secret_files(tmp_path):
 ref='sggrijhyblejlgimgzzc'
 uri='postgresql://postgres.'+ref+':fixture-only@aws.example.pooler.supabase.com:5432/postgres?sslmode=require'
 values={'DATABASE_URL':uri,'DIRECT_URL':uri,'WORKER_DATABASE_URL':uri,'SUPABASE_URL':'https://'+ref+'.supabase.co',
  'SUPABASE_SECRET_KEY':'fixture-only-secret','INTERNAL_API_KEY':'fixture-only-internal-key-32-characters',
  'CORS_ORIGINS':'https://runfinder-rithmy.lovable.app,https://id-preview--e21cded7-e20c-4cde-affb-e861bee99b6e.lovable.app'}
 groups={'api':['DATABASE_URL','SUPABASE_URL','SUPABASE_SECRET_KEY','INTERNAL_API_KEY','CORS_ORIGINS'],
  'calendar':['DATABASE_URL','SUPABASE_URL'],'results':['WORKER_DATABASE_URL','SUPABASE_URL','SUPABASE_SECRET_KEY'],
  'migration':['DATABASE_URL','DIRECT_URL','SUPABASE_URL']}
 for g,keys in groups.items():
  p=tmp_path/(g+'.env');p.write_text(''.join(k+'='+values[k]+'\n' for k in keys));p.chmod(0o600)
 return values
def test_release_requires_immutable_images_and_owned_hostname(tmp_path):
 p=config(tmp_path);assert module.release(p)['API_PUBLIC_HOST']=='api.example.com'
 text=p.read_text()
 for old,new in [('api.example.com','127.0.0.1'),('api.example.com','universal-race-calendar.onrender.com'),('@sha256:'+'b'*64,':latest')]:
  p.write_text(text.replace(old,new))
  with pytest.raises(ValueError):module.release(p)
def test_staging_ssl_and_secret_files_are_required(tmp_path):
 secret_files(tmp_path);module.secrets(tmp_path)
 p=tmp_path/'results.env';text=p.read_text()
 for old,new in [('sslmode=require','sslmode=disable'),('sggrijhyblejlgimgzzc','different-project-ref'),('sslmode=require','sslmode=require&schema=public')]:
  p.write_text(text.replace(old,new))
  with pytest.raises(ValueError):module.secrets(tmp_path)
def test_cli_never_outputs_bad_secret(tmp_path):
 p=config(tmp_path);secret_files(tmp_path)
 (tmp_path/'api.env').write_text('SUPABASE_SECRET_KEY=sentinel-never-print\n')
 r=subprocess.run([sys.executable,str(root/'deploy/aws/preflight.py'),str(p),str(tmp_path)],capture_output=True,text=True)
 assert r.returncode!=0 and 'sentinel-never-print' not in r.stdout+r.stderr
def test_aws_compose_is_remote_only_workers_opt_in_and_logs_bounded():
 c=yaml.safe_load((root/'deploy/aws/compose.yaml').read_text())
 assert set(c['services'])=={'api','calendar-worker','results-worker','caddy','migration'}
 for s in ('calendar-worker','results-worker'):
  x=c['services'][s];assert x['profiles']==['workers'];assert x['restart']=='unless-stopped'
  assert x['environment']['WORKER_MODE']=='continuous';assert 'healthcheck' in x
  assert x['logging']['options']['max-file']=='3'
 assert c['services']['migration']['profiles']==['maintenance']
 assert 'DATABASE_URL' not in json.dumps(c) # never override with local/test DSN
 assert 'postgres:' not in json.dumps(c)
def test_image_workflow_is_manual_has_no_aws_credentials_or_collections():
 w=yaml.safe_load((root/'.github/workflows/aws-images.yml').read_text())
 assert (w.get('on') or w.get(True))=={'workflow_dispatch':None}
 text=(root/'.github/workflows/aws-images.yml').read_text()
 assert 'schedule:' not in text and 'AWS_ACCESS_KEY_ID' not in text and 'workflow_dispatch' in text
 assert 'linux/amd64' in text and 'github.sha' in text

def test_revision_label_must_match_release_even_with_a_valid_digest(tmp_path):
 spec=importlib.util.spec_from_file_location('aws_verify_images',root/'deploy/aws/verify-images.py')
 sys.path.insert(0,str(root/'deploy/aws'))
 try:
  check=importlib.util.module_from_spec(spec);spec.loader.exec_module(check)
  values=module.release(config(tmp_path))
  check.verify(values,'workers',lambda _: 'a'*40)
  with pytest.raises(ValueError):check.verify(values,'api',lambda _: 'e'*40)
 finally:sys.path.pop(0)

def test_short_internal_key_cannot_be_deployed(tmp_path):
 secret_files(tmp_path)
 p=tmp_path/'api.env';p.write_text(p.read_text().replace('fixture-only-internal-key-32-characters','short'))
 with pytest.raises(ValueError):module.secrets(tmp_path)
