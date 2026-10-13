"""Operator-only SSO -> SSH transfer. No secrets in stdout, arguments or AWS UserData."""
import argparse, subprocess, re
import boto3
p=argparse.ArgumentParser()
p.add_argument('--profile',required=True);p.add_argument('--host',required=True);p.add_argument('--ssh-key',required=True)
args=p.parse_args()
if not re.fullmatch(r'[a-zA-Z0-9.-]+',args.host): raise SystemExit('ssh_host_invalid')
groups={
 'api':['DATABASE_URL','SUPABASE_URL','SUPABASE_SECRET_KEY','INTERNAL_API_KEY','CORS_ORIGINS'],
 'calendar':['DATABASE_URL','SUPABASE_URL'],
 'results':['WORKER_DATABASE_URL','SUPABASE_URL','SUPABASE_SECRET_KEY'],
 'migration':['DATABASE_URL','DIRECT_URL','SUPABASE_URL'],
}
try:
 client=boto3.Session(profile_name=args.profile,region_name='sa-east-1').client('ssm')
 names=sorted({n for group in groups.values() for n in group})
 values={}
 for offset in range(0,len(names),10):
  response=client.get_parameters(Names=['/runfinder/staging/'+n for n in names[offset:offset+10]],WithDecryption=True)
  if response.get('InvalidParameters'):raise ValueError()
  secret_names={'DATABASE_URL','DIRECT_URL','WORKER_DATABASE_URL','SUPABASE_SECRET_KEY','INTERNAL_API_KEY'}
  if any(r['Name'].rsplit('/',1)[1] in secret_names and r.get('Type')!='SecureString' for r in response['Parameters']):raise ValueError()
  values.update({r['Name'].rsplit('/',1)[1]:r['Value'] for r in response['Parameters']})
 if set(values)!=set(names):raise ValueError()
 if values['SUPABASE_URL']!='https://sggrijhyblejlgimgzzc.supabase.co': raise ValueError()
 if any(not v or '\n' in v or '\r' in v or '\x00' in v for v in values.values()):raise ValueError()
 for group,keys in groups.items():
  body=''.join(n+'='+values[n]+'\n' for n in keys).encode()
  path="/etc/runfinder/staging/"+group+".env"
  command="sudo sh -c 'test ! -L "+path+" || exit 1; umask 077; cat > "+path+"; chmod 600 "+path+"; chown root:root "+path+"'"
  result=subprocess.run(['ssh','-i',args.ssh_key,'-o','StrictHostKeyChecking=yes','ubuntu@'+args.host,command],
   input=body,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if result.returncode:raise ValueError()
 print('Protected staging files transferred; no AWS credentials stored on server.')
except Exception:raise SystemExit('protected_transfer_failed; credentials omitted')
