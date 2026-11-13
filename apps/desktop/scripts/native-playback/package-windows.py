#!/usr/bin/env python3
"""Package two already-built engine dependency trees and two renderer sources for a real local Windows A/B."""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
DESKTOP = REPO / 'apps/desktop/src-tauri'
ESBUILD = REPO / 'apps/server/node_modules/.bin/esbuild'


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def run(args, **opts):
    return subprocess.run([str(arg) for arg in args], check=True, **opts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-web', type=Path, required=True)
    parser.add_argument('--baseline-engine-root', type=Path, required=True)
    parser.add_argument('--candidate-web', type=Path, default=REPO / 'apps/web')
    parser.add_argument('--candidate-engine-root', type=Path, default=REPO)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    if out.exists():
        parser.error('Provide a new output archive path.')
    with tempfile.TemporaryDirectory(prefix='scarlet-win-package-') as temp:
        root = Path(temp).resolve()
        driver = root / 'driver'
        payload = root / 'payload'
        driver.mkdir()
        payload.mkdir()
        for name in ('windows.py','windows-suite.py','windows-sea.mjs','windows-cdp.mjs','windows-tauri.conf.json','measure.js','mute.js','summarize.mjs'):
            shutil.copy2(HERE / name, driver / name)
        batch = (HERE / 'Run-ScarletBenchmark.cmd').read_text('ascii')
        (root / 'Run-ScarletBenchmark.cmd').write_bytes(batch.replace('\n','\r\n').encode('ascii'))
        shutil.copy2(HERE / 'WINDOWS.md', root / 'README.md')
        native = payload / 'native'
        native.mkdir()
        for name in ('Cargo.lock','Cargo.toml','build.rs','tauri.conf.json','Entitlements.plist','Info.plist'):
            shutil.copy2(DESKTOP / name, native / name)
        config_path = native / 'tauri.conf.json'
        config = json.loads(config_path.read_text('utf8'))
        resources = config['bundle']['resources']
        for source, target in list(resources.items()):
            if target.startswith('crisperwhisper-setup/'):
                staged = native / target
                staged.parent.mkdir(exist_ok=True)
                shutil.copy2(DESKTOP / source, staged)
                del resources[source]
                resources[target] = target
        config_path.write_text(json.dumps(config), 'utf8')
        for dirname in ('src','icons','licenses','capabilities'):
            shutil.copytree(DESKTOP / dirname, native / dirname)
        shutil.copy2(REPO / 'LICENSE', root / 'LICENSE')
        postject = REPO / 'apps/server/node_modules/postject'
        shutil.copy2(postject / 'LICENSE', payload / 'postject-license.txt')
        shutil.copy2(postject / 'dist/api.js', payload / 'postject-api.cjs')
        shutil.copy2(REPO / 'apps/web/public/sample.mp4', payload / 'sample.mp4')
        # Both release renderers use the same private-build revision for their version label.
        # GIT_DIR prevents out-of-repository frozen source trees from stamping a different revision.
        gitdir = run(['git','rev-parse','--absolute-git-dir'],cwd=REPO,capture_output=True,text=True).stdout.strip()
        env = {**os.environ, 'GIT_DIR':gitdir}
        run([ESBUILD, REPO / 'apps/server/scripts/prepare-playback-fixture.mjs','--bundle','--format=esm','--platform=node','--target=node22',
             '--outfile=' + str(payload / 'prepare-fixture.mjs')])
        variants = {}
        for name, web, engine in [('baseline',args.baseline_web,args.baseline_engine_root),('candidate',args.candidate_web,args.candidate_engine_root)]:
            web, engine = web.resolve(), engine.resolve()
            output = payload / name
            output.mkdir()
            run([web / 'node_modules/.bin/vite','build','--outDir',output / 'web'],cwd=web,env=env)
            run([ESBUILD, engine / 'apps/server/dist/cli.js','--bundle','--platform=node','--target=node22','--format=cjs','--minify','--keep-names','--legal-comments=none',
                 '--define:import.meta.url=__scarlet_import_meta_url',
                 '--banner:js=const __scarlet_import_meta_url = require("node:url").pathToFileURL(process.execPath).href;',
                 '--external:node:sqlite','--external:bufferutil','--external:utf-8-validate','--outfile='+str(output / 'engine.cjs')],cwd=engine)
            webfiles = [(p.relative_to(output / 'web').as_posix(),digest(p)) for p in sorted((output / 'web').rglob('*')) if p.is_file()]
            variants[name] = {'webSha256':sha256(json.dumps(webfiles).encode()).hexdigest(),'engineBundleSha256':digest(output / 'engine.cjs'),
                              'scrubSourceSha256':digest(web / 'src/components/player/ScrubPreview.tsx'),
                              'watchSourceSha256':digest(web / 'src/pages/WatchPage.tsx'),
                              **{n+'JsSha256':digest(engine / ('packages/render/dist/'+n+'.js')) for n in ('graph','frame','render','segments')}}
        if variants['baseline'] == variants['candidate']:
            raise ValueError('The supplied variants are identical.')
        files = {p.relative_to(root).as_posix():digest(p) for p in sorted(root.rglob('*')) if p.is_file()}
        (root/'SHA256.json').write_text(json.dumps({'variants':variants,'files':files},indent=2),'utf8')
        with ZipFile(out,'x',compression=ZIP_DEFLATED,compresslevel=6) as archive:
            for file in sorted(root.rglob('*')):
                if file.is_file(): archive.write(file, file.relative_to(root))
        print(json.dumps({'archive':str(out),'sha256':digest(out),'bytes':out.stat().st_size,'variants':variants}),flush=True)


if __name__ == '__main__':
    main()
