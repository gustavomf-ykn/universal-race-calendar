import json
import pytest
from worker_health import healthy,write_health
def test_health_is_own_process_freshness_not_task_success(tmp_path,monkeypatch):
 path=tmp_path/'health.json'
 monkeypatch.setenv('WORKER_HEALTH_FILE',str(path))
 write_health('resource_wait')
 data=json.loads(path.read_text())
 assert healthy(path,now=data['updatedAt']+20)
 assert not healthy(path,now=data['updatedAt']+61)
 assert not healthy(path,now=data['updatedAt']-6)
 write_health('stopped')
 assert not healthy(path)
def test_missing_or_malformed_health_never_passes(tmp_path):
 with pytest.raises(OSError):healthy(tmp_path/'missing')
 path=tmp_path/'invalid';path.write_text('{}')
 with pytest.raises(KeyError):healthy(path)

def test_aws_identity_is_checked_before_connecting(monkeypatch):
 from aws_staging import assert_aws_staging
 ref='sggrijhyblejlgimgzzc'
 monkeypatch.setenv('HOSTING_TARGET','aws')
 monkeypatch.setenv('SUPABASE_URL','https://'+ref+'.supabase.co')
 uri='postgresql://postgres.'+ref+':fixture-only@aws.example.pooler.supabase.com:5432/postgres?sslmode=require'
 monkeypatch.setenv('WORKER_DATABASE_URL',uri);assert_aws_staging()
 for value in [uri.replace('require','disable'),uri.replace(ref,'other'),uri+'&schema=public']:
  monkeypatch.setenv('WORKER_DATABASE_URL',value)
  with pytest.raises(RuntimeError,match='aws_staging_configuration_rejected'):assert_aws_staging()
