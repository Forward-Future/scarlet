#!/usr/bin/env python3
"""Build and compare the packaged Scarlet variants on a Windows machine with local 4K footage."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import uuid

HERE = Path(__file__).resolve().parent


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def verify_payload(folder):
    manifest = json.loads((folder / 'SHA256.json').read_text('utf8'))
    for name, expected in manifest['files'].items():
        path = (folder / name).resolve()
        if folder not in path.parents or digest(path) != expected:
            raise RuntimeError('Payload checksum mismatch: ' + name)
    return manifest


def is_uhd(width, height):
    dimensions = sorted((width or 0, height or 0))
    return dimensions[0] >= 2160 and dimensions[1] >= 3840


def select_project(library, requested, version='head', allow_hd=False):
    with sqlite3.connect((library / 'scarlet.db').as_uri() + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        projects = db.execute("""SELECT id, head, settings FROM projects WHERE archived=0 AND deleted_at IS NULL
                                 AND (? IS NULL OR id=?) ORDER BY updated_at DESC, id""", (requested, requested))
        eligible = []
        for project, head, options in projects:
            settings = json.loads(options)
            width, height = settings['width'], settings['height']
            uhd = is_uhd(width, height)
            if not uhd and not allow_hd:
                continue
            assets = db.execute("""SELECT id, json_extract(json,'$.width'), json_extract(json,'$.height') FROM media
                                  WHERE project_id=? AND status='ready' AND json_extract(json,'$.kind')='video'""", (project,))
            uhd_assets = {media for media, w, h in assets if is_uhd(w, h)}
            if not uhd_assets:
                continue
            wanted = head if version == 'head' else version
            versions = db.execute("""SELECT version, json FROM timeline_versions WHERE project_id=?
                                    AND (?='dense' OR version=?) ORDER BY created_at DESC, version""", (project, version, wanted))
            selected = None
            for identifier, source in versions:
                clips = [c for t in json.loads(source)['tracks'] if t['kind']=='video' and not t.get('hidden')
                         for c in t['clips'] if c.get('enabled', True)]
                used = sorted({c.get('mediaId') for c in clips if c.get('kind')=='media'
                               and c.get('opacity',1)>0 and c.get('sourceOut',0)>c.get('sourceIn',0)} & uhd_assets)
                if used and (selected is None or len(clips) > selected['visibleClips']):
                    selected = {'project':project, 'version':identifier, 'width':width, 'height':height, 'usedUhdAssets':used,
                                'visibleClips':len(clips), 'timelineSha256':hashlib.sha256(source.encode('utf8')).hexdigest()}
            if selected and uhd:
                return selected
            if selected:
                eligible.append(selected)
        if eligible:
            return eligible[0]
    raise ValueError('No qualifying local version uses UHD footage on a visible video track of a UHD timeline. '
                     'Choose --project-id/--version, or explicitly allow a lower-resolution timeline using --allow-hd-timeline.')


def source_bytes(library, project):
    with sqlite3.connect((library / 'scarlet.db').as_uri() + '?mode=ro', uri=True) as db:
        names = db.execute("SELECT json_extract(json,'$.path') FROM media WHERE project_id=?", (project,)).fetchall()
    media = (library / 'projects' / project / 'media').resolve()
    if library not in media.parents:
        raise ValueError('The project media directory must be inside the local library.')
    total = 0
    for name, in names:
        if not name or Path(name).name != name or (media / name).resolve().parent != media:
            raise ValueError('The fixture needs regular media files inside the local library.')
        total += (media / name).stat().st_size
    return total


def discover(provided, candidates, required, option):
    for candidate in ([provided] if provided else candidates):
        if all((candidate / name).is_file() for name in required):
            return candidate.resolve()
    raise ValueError('Cannot discover ' + ', '.join(required) + '. Pass ' + option + ' pointing to their local directory.')


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def prepare_variant(payload, label, build, node, cargo, provenance):
    assets = payload / label
    native = build / 'apps/desktop/src-tauri'
    settings = json.loads((HERE / 'windows-tauri.conf.json').read_text('utf8'))
    # A drive-letter Windows path can parse as a URL in Tauri's FrontendDist.
    # Keep each dist relative to the private Cargo crate, even across volumes.
    web = build / ('web-' + label)
    shutil.copytree(assets / 'web', web)
    (web / 'scarlet-benchmark-variant.json').write_text(json.dumps({'variant': label, 'webSha256': provenance['webSha256']}), 'utf8')
    settings['build']['frontendDist'] = '../../../web-' + label
    # Cargo reads the exact Tauri config used by both build.rs and generate_context!.
    env = {**os.environ, 'CI': 'true', 'CARGO_TARGET_DIR': str(build / 'target'), 'TAURI_CONFIG': json.dumps(settings)}
    run([cargo, 'build', '--release', '--locked', '--features', 'tauri/custom-protocol',
         '--manifest-path', native / 'Cargo.toml'], env=env, cwd=native)
    variant = build / label
    variant.mkdir()
    app = variant / 'scarlet-desktop.exe'
    shutil.copy2(build / 'target/release/scarlet-desktop.exe', app)
    engine = variant / 'scarlet-engine.exe'
    run([node, HERE / 'windows-sea.mjs', assets / 'engine.cjs', engine, payload / 'postject-api.cjs'])
    if 'scarlet-engine <command>' not in run([engine, '--help'], capture_output=True, text=True).stdout:
        raise RuntimeError('The generated Windows SEA did not identify itself as Scarlet.')
    return app, engine


def default_schedule(manifest, quick=False):
    cuts, duration = manifest['cutTimes'], manifest['duration']
    count = min(2 if quick else 24, len(cuts))
    # Choose the center of each stratum. The fixture already permutes 64
    # uniformly stratified seek targets in both directions across the timeline.
    selected = [cuts[((2*i+1)*len(cuts)) // (2*count)] for i in range(count)]
    stride = 7
    while count and math.gcd(stride,count) != 1:
        stride += 1
    selected = [selected[(i*stride) % count] for i in range(count)]
    seconds = min(3 if quick else 10, duration)
    starts = [0] if quick or duration < 2*seconds else [duration*.20, duration*.65]
    return {'fps':manifest['settings']['fps'], 'width':manifest['settings']['width'], 'height':manifest['settings']['height'],
            'cacheMediaIds':[a['id'] for a in manifest['assets'] if a['kind']=='video'],
            'scrubTimes':manifest['scrubTimes'][:8 if quick else 64], 'cutTimes':selected, 'timeoutMs':12000,
            'batchCount':1 if quick else 4,
            'playWindows':[{'start':min(start,duration-seconds), 'seconds':seconds} for start in starts] if seconds > 1 else []}


def compare_pair(node, out, stage, missed):
    labels = ('baseline', 'candidate')
    reports = {label:json.loads((out / (stage+'-'+label+'.json')).read_text('utf8'))['results'] for label in labels if label not in missed}
    fields = ('scrub','cuts','sustained')
    counts = {label:{field:sum(r.get('cachePhase') == 'caching' for r in data[field]) for field in fields} for label,data in reports.items()}
    for label in missed:
        counts[label] = dict.fromkeys(fields,0)
    evidence = {'stage':stage, 'missedBeforeSampling':missed, 'verifiedWhileCaching':counts if stage=='during' else None,
                'minimumSeeksForP95':40, 'minimumObservedCutsForP95':12}
    if missed:
        (out / (stage+'-summary.json')).write_text(json.dumps({**evidence,'paired':False,
            'reason':'Cache completed before one or both variants could sample. Completed variant data remains in the raw report.'},indent=2),'utf8')
        return
    if stage == 'during':
        # Intersect planned indices so unequal cache durations never compare
        # one variant's hardest targets to a different set on the other.
        for field in fields:
            good = [{i for i,r in enumerate(reports[label][field]) if r['cachePhase']=='caching'} for label in labels]
            matched = sorted(good[0] & good[1])
            for label in labels:
                reports[label][field] = [reports[label][field][i] for i in matched]
        evidence['matchedWhileCaching'] = {field:len(reports['baseline'][field]) for field in fields}
    evidence['scrubP95Status'] = 'reported' if len(reports['baseline']['scrub']) >= 40 else 'insufficient matched seeks'
    with tempfile.TemporaryDirectory(prefix='scarlet-pair-summary-') as temp:
        paths = []
        for label in labels:
            path = Path(temp) / (label+'.json')
            path.write_text(json.dumps(reports[label]),'utf8')
            paths.append(path)
        summary = json.loads(run([node,HERE/'summarize.mjs',*paths],capture_output=True,text=True).stdout)
    for entry in summary['runs']:
        if entry['scrubs']['attempts'] < 40: entry['scrubs']['p95Ms'] = None
        if entry['cuts']['observed'] < 12: entry['cuts']['observedExcessP95Ms'] = None
        if entry['playback']['started'] < 12: entry['playback']['playToFirstFrameP95Ms'] = None
    for group in summary.get('matchedDeadlines',[]):
        for side in ('before','after'):
            if group[side]['attempts'] < 40: group[side]['p95Ms'] = None
    if sum(r.get('latencyMs') is not None for r in reports['baseline']['scrub']) < 40:
        summary.pop('slowestCompletedBaselineTargets',None)
    (out / (stage+'-summary.json')).write_text(json.dumps({**evidence,'paired':True,**summary},indent=2),'utf8')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--library', type=Path, help='Production data directory containing scarlet.db (read-only)')
    p.add_argument('--sidecars', type=Path, help='Existing installed directory containing ffmpeg.exe and ffprobe.exe')
    p.add_argument('--project-id', help='Defaults to a UHD timeline with UHD video actively used by its selected version')
    p.add_argument('--allow-hd-timeline', action='store_true', help='Explicitly allow a lower-resolution timeline using real UHD video')
    p.add_argument('--quick', action='store_true', help='Short diagnostic schedule; 8 seeks, 2 joins and one playback window')
    p.add_argument('--version', default='head', help='head, dense, or a specific installed timeline version')
    p.add_argument('--stages', default='current,during,after', help='Comma-separated current, during, after')
    p.add_argument('--out', type=Path, help='New result directory, defaults to a new folder in the current directory')
    p.add_argument('--config', type=Path, help='Use a custom shared measurement schedule, identical for both variants')
    p.add_argument('--timeout', type=int, default=3600, help='Per-trial wall-clock limit in seconds')
    p.add_argument('--preflight', action='store_true', help='Check the archive, toolchain and real local 4K project without building or opening Scarlet')
    args = p.parse_args()
    if sys.platform != 'win32' or sys.version_info < (3, 11):
        p.error('Run locally on Windows with Python 3.11 or newer.')
    payload = HERE.parent / 'payload'
    verified = verify_payload(HERE.parent)
    stages = args.stages.split(',')
    if not stages or any(s not in ('current', 'during', 'after') for s in stages) or len(set(stages)) != len(stages):
        p.error('--stages must contain distinct values from current,during,after.')
    local, roaming = Path(os.environ['LOCALAPPDATA']), Path(os.environ['APPDATA'])
    media = discover(args.sidecars, [local / 'Scarlet', local / 'Programs/Scarlet', Path(os.environ['ProgramFiles']) / 'Scarlet'],
                     ['ffmpeg.exe', 'ffprobe.exe'], '--sidecars')
    library = discover(args.library, [(p / 'com.forwardfuture.scarlet/data') for p in (roaming, local)], ['scarlet.db'], '--library')
    from windows import local_path, powershell
    if not all(local_path(path) for path in (library, media, Path(tempfile.gettempdir()), args.out or Path.cwd())):
        p.error('Keep the original library, disposable copies, binaries and results on local Windows volumes.')
    selection = select_project(library, args.project_id, args.version, args.allow_hd_timeline)
    project, width, height = (selection[k] for k in ('project','width','height'))
    # The trial uses a full local copy on NTFS, then builds a source proxy.
    # Check before starting a long Rust build or partially copying large recordings.
    media_size = source_bytes(library, project)
    if shutil.disk_usage(tempfile.gettempdir()).free < media_size + 3 * (1024**3):
        p.error(f'The temp volume needs room for {media_size / (1024**3):.1f} GiB of project assets plus at least 3 GiB of build/cache space.')
    node, cargo, rustc = (shutil.which(n) for n in ('node.exe', 'cargo.exe', 'rustc.exe'))
    if not (node and cargo and rustc):
        p.error('Install prerequisites locally: Node.js 24 x64, stable Rust MSVC x64 and Microsoft C++ Build Tools with the Windows SDK.')
    node_version = run([node, '-p', 'process.versions.node'], capture_output=True, text=True).stdout.strip()
    rust = run([rustc, '-vV'], capture_output=True, text=True).stdout
    if node_version.split('.')[0] != '24' or 'host: x86_64-pc-windows-msvc' not in rust:
        p.error('Use Node.js 24.x and x86_64-pc-windows-msvc Rust, the Scarlet release toolchain.')
    run([node, '-e', "if (process.arch !== 'x64') process.exit(1);require('node:sqlite')"])
    program_x86 = Path(os.environ.get('ProgramFiles(x86)', os.environ['ProgramFiles']))
    edge_roots = [p / 'Microsoft/EdgeWebView/Application' for p in (program_x86, local, Path(os.environ['ProgramFiles']))]
    if not any(any(root.glob('*/msedgewebview2.exe')) for root in edge_roots):
        p.error('The installed Microsoft Edge WebView2 Runtime was not found.')
    if not shutil.which('rc.exe') and not any((program_x86 / 'Windows Kits/10/bin').glob('*/x64/rc.exe')):
        p.error('The x64 Windows SDK resource compiler (rc.exe) is required.')
    with tempfile.TemporaryDirectory(prefix='scarlet-link-check-') as temp:
        probe = Path(temp) / 'link_check.rs'
        probe.write_text('fn main() {}', 'utf8')
        run([rustc, probe, '--target', 'x86_64-pc-windows-msvc', '-o', Path(temp) / 'link_check.exe'])
    if powershell('Get-Process -Name "scarlet-desktop" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id; exit 0'):
        p.error('Close other Scarlet preview windows before starting.')
    print(f'Payload verified. Local 4K footage selected, timeline {width}x{height}, Windows build prerequisites found.', flush=True)
    if args.preflight:
        return
    out = (args.out or (Path.cwd() / ('scarlet-results-' + uuid.uuid4().hex[:8]))).resolve()
    if out == library or library in out.parents or out in library.parents:
        p.error('Choose a fresh output directory outside the production library.')
    out.mkdir()
    print('Results:', out, flush=True)
    with tempfile.TemporaryDirectory(prefix='scarlet-native-build-') as temp:
        build = Path(temp)
        shutil.copytree(payload / 'native', build / 'apps/desktop/src-tauri')
        # Release code only includes this file in a compile-time-false debug-demo branch.
        # Keep the known public repository fixture; never copy footage into the archive.
        public = build / 'apps/web/public'
        public.mkdir(parents=True)
        shutil.copy2(payload / 'sample.mp4', public / 'sample.mp4')
        variants = {label: prepare_variant(payload, label, build, node, cargo, verified['variants'][label]) for label in ('baseline', 'candidate')}
        for i, key in enumerate(('webSha256','engineBundleSha256')):
            if verified['variants']['baseline'][key] != verified['variants']['candidate'][key] and digest(variants['baseline'][i]) == digest(variants['candidate'][i]):
                raise RuntimeError('Different inputs generated identical variant executables: ' + key)
        provenance = {'payload': verified['variants'], 'node': node_version, 'rust': rust.strip(), 'ffmpegSha256': digest(media / 'ffmpeg.exe')}
        (out / 'provenance.json').write_text(json.dumps(provenance, indent=2), 'utf8')
        # Each variant starts from its own database and source files. Keep at most one full fixture on disk at a time.
        for index, stage in enumerate(stages):
            reference = None
            missed = []
            for label in (('baseline', 'candidate') if index % 2 == 0 else ('candidate', 'baseline')):
                with tempfile.TemporaryDirectory(prefix='scarlet-native-trial-') as workspace:
                    fixture = Path(workspace) / 'fixture'
                    run([node, payload / 'prepare-fixture.mjs', '--library', library, '--project', project,
                         '--version', selection['version'], '--cache', 'one' if stage == 'current' else 'none', '--copy', '--out', fixture],
                        env={**os.environ,'SCARLET_BIN_DIR':str(media),'SCARLET_FFPROBE':str(media/'ffprobe.exe')})
                    manifest = json.loads((fixture / 'manifest.json').read_text('utf8'))
                    match = {k: manifest[k] for k in ('projectId', 'version', 'settings', 'duration', 'assets', 'cache', 'cutTimes', 'scrubTimes', 'confirmedUhd')}
                    proof = match['confirmedUhd']
                    if proof['id'] not in selection['usedUhdAssets'] or not is_uhd(proof['width'],proof['height']):
                        raise RuntimeError('Physical UHD source verification did not match the selected cut.')
                    match['selectedCut'] = selection
                    with sqlite3.connect((fixture/'data/scarlet.db').as_uri()+'?mode=ro',uri=True) as db:
                        row = db.execute('SELECT json FROM timeline_versions WHERE project_id=? AND version=?',(project,selection['version'])).fetchone()
                    if not row or hashlib.sha256(row[0].encode('utf8')).hexdigest()!=selection['timelineSha256']:
                        raise RuntimeError('The qualifying UHD cut changed during setup.')
                    candidates = [a for a in manifest['assets'] if a['id'] in selection['usedUhdAssets']]
                    target = max(candidates,key=lambda a:a['bytes'])['id']
                    match['measuredCacheTarget'] = target
                    if reference is not None and reference != match:
                        raise RuntimeError('Source project or cache changed between paired trials. The pair cannot be compared.')
                    reference = match
                    config = Path(workspace) / 'config.json'
                    schedule = json.loads(args.config.read_text('utf-8-sig')) if args.config else default_schedule(manifest, args.quick)
                    schedule.setdefault('timeoutMs', 12000)
                    schedule.setdefault('timelineCuts', manifest['cutTimes'])
                    schedule['expectedRenderer'] = {'variant': label, 'webSha256': verified['variants'][label]['webSha256']}
                    config.write_text(json.dumps(schedule), 'utf8')
                    (out / (stage + '-fixture.json')).write_text(json.dumps(match, indent=2), 'utf8')
                    try:
                        run([sys.executable, HERE / 'windows.py', '--app', variants[label][0], '--engine', variants[label][1],
                             '--sidecars', media, '--fixture', fixture, '--config', config, '--cache-stage', stage, '--cache-target', target,
                             '--timeout', str(args.timeout), '--out', out / (stage + '-' + label + '.json')])
                    except subprocess.CalledProcessError as error:
                        if stage != 'during' or error.returncode != 89:
                            raise
                        missed.append(label)
            compare_pair(node, out, stage, missed)
    print('Finished:', out, flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        sys.exit(str(error))
