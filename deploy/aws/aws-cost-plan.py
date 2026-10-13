"""Read-only plan. Requires operator SSO profile; never creates AWS resources."""
import argparse, json
import boto3
p=argparse.ArgumentParser()
p.add_argument('--profile',required=True)
p.add_argument('--snapshot-gb',type=float,default=0)
args=p.parse_args()
if args.snapshot_gb<0: raise SystemExit('snapshot_estimate_invalid')
try:
 client=boto3.Session(profile_name=args.profile,region_name='sa-east-1').client('lightsail')
 bundles=[];token=None
 while True:
  page=client.get_bundles(includeInactive=False,**({'pageToken':token} if token else {}));bundles.extend(page['bundles'])
  token=page.get('nextPageToken')
  if not token:break
 matched=[b for b in bundles if b.get('ramSizeInGb')==8 and b.get('cpuCount')==2
  and b.get('supportedPlatforms')==['LINUX_UNIX'] and b.get('price')==44 and 'ipv6' not in b.get('bundleId','')]
 if len(matched)!=1: raise ValueError()
 bundle=matched[0]
 blueprints=[];token=None
 while True:
  page=client.get_blueprints(includeInactive=False,**({'pageToken':token} if token else {}));blueprints.extend(page['blueprints'])
  token=page.get('nextPageToken')
  if not token:break
 blueprint=next(b for b in blueprints if b['blueprintId']=='ubuntu_24_04')
 estimate=bundle['price']+args.snapshot_gb*0.05
 print(json.dumps({'region':'sa-east-1','bundleId':bundle['bundleId'],'blueprintId':blueprint['blueprintId'],
  'instanceUsd':bundle['price'],'snapshotEstimateUsd':args.snapshot_gb*0.05,
  'estimatedAwsUsd':estimate,'withinBudget':estimate<=50,
  'excludes':['taxes','domain','excess_transfer','optional_services'],'resourcesCreated':False}))
 if estimate>50: raise SystemExit(2)
except SystemExit: raise
except Exception: raise SystemExit('cost_plan_unconfirmed; check operator profile and current regional offers')
