"""Export the patched core and its HelloDog integration without user profiles."""
import json, pathlib, subprocess, zipfile, hashlib
root = pathlib.Path(__file__).resolve().parents[1]
core = (root / 'integrations/signal-desktop').resolve()
release = root / 'release'
release.mkdir(exist_ok=True)
version=json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
target = release / f'HelloDog-{version}-corresponding-source.zip'
tracked = subprocess.check_output(['git','ls-files','-z'],cwd=core).decode().split('\0')
extra = ['app/hellodog.main.ts','app/hellodog.privacy.main.ts','images/hellodog-icon.png','ts/hellodog/hellodog.preload.ts','ts/hellodog/hellodog.privacy.preload.ts','ts/hellodog/hellodog.recovery.preload.ts','ts/hellodog/hellodog.focus.preload.ts','ts/hellodog/hellodog.quick-reply.dom.ts','ts/hellodog/fs-xattr.d.ts','patches/uuid@13.0.0.patch']
count = 0
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for name in sorted(set(tracked + extra)):
        source = core / name
        if name and source.is_file():
            archive.write(source,'hellodog/integrations/signal-desktop/'+name)
            count += 1
    paths = []
    for directory in ['src','scripts','security','.github/workflows','resources/security','resources/brand','tests','integrations/hellodog-source','integrations/notices',
                      'server/worker/src','website/src','website/public','supabase/migrations']:
        paths.extend((root / directory).rglob('*'))
    paths.extend((root / 'resources/native').glob('*.cs'))
    paths.extend((root / 'resources/signal').glob('*.txt'))
    paths.extend(root.glob('tsconfig*.json'))
    paths.extend(root / 'docs/product' / name for name in [f'optimization-implementation-{version}.md','optimization-roadmap-2026-09-12.md','experience-stability-plan-2026-09-12.md','security-plan-2026-09-14.md','security-operations-2026-09-14.md','security-implementation-2026-09-14.md'])
    paths.extend(root / name for name in ['package.json','pnpm-lock.yaml','electron.vite.config.ts','integrations/README.md','integrations/signal-desktop.lock.json',f'docs/product/release-{version}.md'])
    paths.extend(root / 'website' / name for name in ['package.json','pnpm-lock.yaml','tsconfig.json','vite.config.ts','index.html','worker.mjs','wrangler.jsonc','README.md'])
    paths.extend(root / 'server/worker' / name for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','wrangler.jsonc','worker-configuration.d.ts','README.md'])
    for source in sorted(set(paths)):
        name=source.relative_to(root)
        if source.is_file() and not any(part in ['node_modules','verification','__pycache__','.git'] or part.startswith('.env') for part in name.parts):
            archive.write(source,'hellodog/'+name.as_posix())
            count+=1
with target.open('rb') as file: digest=hashlib.file_digest(file,'sha256').hexdigest()
result={'file':target.name,'sha256':digest,'files':count,'size':target.stat().st_size}
(release / ('source-manifest-'+version+'.json')).write_text(json.dumps(result,indent=2),encoding='utf8')
print(json.dumps(result))
