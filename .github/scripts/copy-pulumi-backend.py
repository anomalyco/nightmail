"""One-way, verified copy under the deploy stage lock, before any Pulumi process starts.

The completion marker prevents ever overlaying newer target state from the old backend.
Do not copy active locks; a partial first copy may resume only if every existing key matches.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

stage = os.environ['STAGE']
account = {'dev':'d8e944f537ceef3f06a5bd3aec1d7a53','production':'15d29c8639fd3733b1b5486a2acfd968'}[stage]
assert os.environ['CF_ACCOUNT_ID'] == account
old, new = (f'{p}-{stage}-pulumi' for p in ('bane', 'nightmail'))
cli = ['aws','--profile','r2','--endpoint-url',f'https://{account}.r2.cloudflarestorage.com','s3api']
marker = '.nightmail-backend-migration-v1'
checkpoint = f'.pulumi/stacks/bane/{stage}.json'

def call(*args):
    return subprocess.check_output([*cli,*args])

def manifest(bucket):
    rows = json.loads(call('list-objects-v2','--bucket',bucket)).get('Contents',[])
    return {r['Key']:(r['Size'],r['ETag']) for r in rows}

dest = manifest(new)
if marker in dest:
    if checkpoint not in dest: raise SystemExit('Migrated backend has no checkpoint; stop')
    print('Using previously migrated backend')
else:
    from urllib.parse import quote
    source = manifest(old)
    if checkpoint not in source or any(k.startswith('.pulumi/locks/') for k in source):
        raise SystemExit('Source checkpoint missing or locked; stop')
    if any(source.get(k)!=v for k,v in dest.items()): raise SystemExit('Destination differs; stop')
    for k,(size,etag) in source.items():
        if k not in dest:
            call('copy-object','--bucket',new,'--key',k,'--copy-source',old+'/'+quote(k,safe='/'),'--copy-source-if-match',etag)
    if manifest(old)!=source or manifest(new)!=source: raise SystemExit('Backend manifests differ; stop')
    # Pulumi checkpoints contain secrets. Compare contents without exposing state in command output.
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as tmp:
        files = [Path(tmp)/name for name in ('source','target')]
        for b,file in zip((old,new),files): call('get-object','--bucket',b,'--key',checkpoint,str(file))
        if files[0].read_bytes()!=files[1].read_bytes(): raise SystemExit('Checkpoint contents differ; stop')
        flag=Path(tmp)/'record'; flag.write_text(json.dumps({'stage':stage,'source':old,'checkpoint_etag':source[checkpoint][1]}))
        call('put-object','--bucket',new,'--key',marker,'--body',str(flag))
    print(f'Verified {len(source)} backend objects and the stage checkpoint; old backend retained')
