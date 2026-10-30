#!/usr/bin/env python3
"""Create a clean source bundle, optionally including a verified plugin."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXACT = {
    '.env.example', '.gitignore', '.github/workflows/distribution.yml',
    'package.json', 'package-lock.json', 'tsconfig.json', 'cordis.patch.yml',
    'README.md', 'CONTRIBUTING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'docs/SUBMISSION.md', 'docs/RESOURCE-INVENTORY.md', 'docs/SECURITY.md',
    'docs/evidence/product-trial-2026-10-02/after.json',
}
DIRECTORIES = ('src/', 'tests/', 'scripts/', 'skills/', 'third_party/')
SECRET = re.compile(rb'(?<![\w])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:or-v1-)?[A-Za-z0-9]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)')

def run(*args, env=None):
    return subprocess.check_output(args, cwd=ROOT, env=env, stderr=subprocess.STDOUT)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def allowed(name):
    return (name in EXACT or name.startswith(DIRECTORIES)) and not name.startswith('scripts/voiceover/')

def safe(name):
    p = PurePosixPath(name)
    return not p.is_absolute() and '..' not in p.parts and '\\' not in name

def scan_secret(name, data):
    if SECRET.search(data):
        raise RuntimeError('Possible credential found; inspect locally before shipping: ' + name)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-only', action='store_true', help='Include source and online installation instructions, without a plugin archive')
    parser.add_argument('--plugin-dir', type=Path, help='Use a downloaded Release folder instead of rebuilding the plugin')
    parser.add_argument('--out-dir', type=Path, default=ROOT / 'artifacts/competition-submission')
    args = parser.parse_args()
    if args.source_only and args.plugin_dir:
        parser.error('--source-only cannot be combined with --plugin-dir')
    commit = run('git', 'rev-parse', 'HEAD').decode().strip()
    if run('git', 'status', '--porcelain', '--untracked-files=no').strip():
        raise RuntimeError('Commit tracked changes before building a submission')
    tree = run('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    started = datetime.now(timezone.utc).isoformat()
    print('Checking types, behavior, local Git workflows and build...', flush=True)
    check = subprocess.run([npm, 'run', 'check'], cwd=ROOT, capture_output=True)
    log = check.stdout + check.stderr
    logdir = ROOT / 'artifacts/submission-preparation-20261030'
    logdir.mkdir(parents=True, exist_ok=True)
    (logdir / 'final-check.log').write_bytes(log)
    if check.returncode:
        raise RuntimeError('npm run check failed; see the local final-check.log (not shipped)')
    text = log.decode(errors='replace')
    counts = {key: int(re.findall(r'\b' + key + r' (\d+)\b', text)[-1]) for key in ('tests', 'pass', 'fail', 'skipped')}
    if not counts['tests'] or counts['fail'] or counts['pass'] != counts['tests']:
        raise RuntimeError('Incomplete or failing test run')
    metadata = {'version': None, 'sha256': None}
    if not args.source_only:
        if args.plugin_dir:
            plugin_dir = args.plugin_dir.resolve()
        else:
            env = {**os.environ, 'DISTRIBUTION_CHANNEL': 'release'}
            print('Building installable distribution...', flush=True)
            run(npm, 'run', 'package:distribution', env=env)
            plugin_dir = ROOT / 'artifacts'
        metadata = json.loads((plugin_dir / 'distribution.json').read_text())
        archive = plugin_dir / 'dsh-maintainer-workbench.tgz'
        run('node', 'scripts/verify-distribution.mjs', str(archive))
        plugin = archive.read_bytes()
        if metadata['commit'] != commit or metadata['sha256'] != digest(plugin):
            raise RuntimeError('Plugin is not bound to the current commit and SHA256')
    source = {}
    with tarfile.open(fileobj=io.BytesIO(run('git', 'archive', '--format=tar', 'HEAD'))) as t:
        for entry in t:
            if not allowed(entry.name):
                continue
            if not safe(entry.name):
                raise RuntimeError('Unsafe source entry: ' + entry.name)
            if entry.isdir():
                continue
            if not entry.isfile():
                raise RuntimeError('Refusing source symlink or special file: ' + entry.name)
            data = t.extractfile(entry).read()
            scan_secret(entry.name, data)
            source[entry.name] = data
    missing = EXACT - source.keys()
    if missing:
        raise RuntimeError('Missing source files: ' + ', '.join(sorted(missing)))
    manifest = json.loads(source['package.json'])
    notices = json.loads(source['third_party/runtime/manifest.json'])
    for notice in notices:
        if digest(source[notice['notice']]) != notice['sha256']:
            raise RuntimeError('Source license hash mismatch: ' + notice['name'])
    if not args.source_only:
        with tarfile.open(fileobj=io.BytesIO(plugin), mode='r:gz') as t:
            members = {m.name: m for m in t.getmembers()}
            for name, m in members.items():
                if not safe(name) or not m.isfile() and not m.isdir():
                    raise RuntimeError('Unsafe distribution entry: ' + name)
                if m.isfile():
                    scan_secret(name, t.extractfile(m).read())
            pm = json.load(t.extractfile('package/package.json'))
            if pm['gitHead'] != commit or pm['version'] != metadata['version']:
                raise RuntimeError('Installed manifest version/commit mismatch')
            for notice in notices:
                content = t.extractfile('package/' + notice['notice']).read()
                if digest(content) != notice['sha256']:
                    raise RuntimeError('Distribution license hash mismatch: ' + notice['name'])
    audit_run = subprocess.run([npm, 'audit', '--omit=dev', '--json'], cwd=ROOT, capture_output=True)
    try:
        audit_raw = json.loads(audit_run.stdout)
    except ValueError:
        audit_raw = {}
    audit = {'status': 'completed' if 'metadata' in audit_raw else 'unavailable',
             'counts': audit_raw.get('metadata', {}).get('vulnerabilities'),
             'advisories': [{'name': name, 'severity': item.get('severity'), 'fixAvailable': item.get('fixAvailable'),
                            'urls': [v.get('url') for v in item.get('via', []) if isinstance(v, dict)]}
                           for name, item in audit_raw.get('vulnerabilities', {}).items()]}
    verification = {'commit': commit, 'sourceTree': tree, 'startedAt': started,
                    'finishedAt': datetime.now(timezone.utc).isoformat(),
                    'commands': {'npm run check': {'exitCode': check.returncode, **counts},
                                 'distribution': 'not included; install from the published Release URL' if args.source_only else 'verified actual archive, JS syntax, entrypoints, no install hooks',
                                 'runtimeNotices': {'entries': len(notices), 'hashesMatchSource': True, 'hashesMatchDistribution': None if args.source_only else True}},
                    'tools': {tool: run(tool, '--version').decode().strip() for tool in ('node', npm, 'git', sys.executable)},
                    'productionDependencyAudit': audit,
                    'scope': 'Engineering checks, local Git/API fixtures; no paid model invocation or real GitHub write. Not a security certification or model-quality benchmark.'}
    files = {'source/' + name: data for name, data in source.items()}
    release_url = 'https://github.com/Acckion/dsh-maintainer-workbench/releases/tag/v' + manifest['version']
    install_url = 'https://github.com/Acckion/dsh-maintainer-workbench/releases/download/v' + manifest['version'] + '/dsh-maintainer-workbench.tgz'
    if not args.source_only:
        for name in ('dsh-maintainer-workbench.tgz', 'distribution.json', 'SHA256SUMS'):
            files['plugin/' + name] = (plugin_dir / name).read_bytes()
        canonical = f"{metadata['sha256']}  dsh-maintainer-workbench.tgz\n".encode()
        if files['plugin/SHA256SUMS'] != canonical:
            raise RuntimeError('Distribution checksum file mismatch')
    files['verification.json'] = (json.dumps(verification, ensure_ascii=False, indent=2) + '\n').encode()
    source_hash = digest(b''.join(name.encode() + b'\0' + digest(data).encode() + b'\n' for name, data in sorted(source.items())))
    submission = {'name': manifest['name'], 'sourceVersion': manifest['version'], 'distributionVersion': metadata['version'],
                  'commit': commit, 'sourceTree': tree, 'sourceInventorySha256': source_hash,
                  'repository': 'https://github.com/Acckion/dsh-maintainer-workbench',
                  'release': release_url,
                  'packageMode': 'source-with-online-install' if args.source_only else 'source-and-plugin',
                  'installation': {'spec': install_url, 'releaseVersion': manifest['version'],
                                   'note': 'Published release and source snapshot have separate commits; release provenance is in its distribution.json.'},
                  'sourceFileCount': len(source), 'pluginSha256': metadata['sha256'],
                  'selection': {'rootFiles': sorted(EXACT), 'sourceDirectories': list(DIRECTORIES),
                                'excluded': ['.git history', 'node_modules', 'credentials and runtime data', 'raw media and editing projects',
                                             'production voiceover helpers', 'historical competition drafts and screenshots',
                                             'old exported reports', 'old release archives', 'official competition reference PDFs',
                                             'external acceptance repository code', 'redundant pnpm lockfile']},
                  'separateCompetitionMaterials': ['Final technical report PDF', 'Final demonstration MP4', 'Team declarations and any required platform fields']}
    files['submission.json'] = (json.dumps(submission, ensure_ascii=False, indent=2) + '\n').encode()
    files['阅读说明.txt'] = (f'''开源维护智能工作台 · 赛事工程包
源码提交：{commit}
源码版本：{manifest['version']}
工程包类型：{'源码与在线安装说明' if args.source_only else '源码与预编译插件'}

请先阅读 source/README.md 和 source/docs/SUBMISSION.md。
已有兼容 Harness：{'使用下面的在线安装地址。' if args.source_only else '安装 plugin/dsh-maintainer-workbench.tgz。'}
在线安装地址：{install_url}
从源码复现：进入 source，执行 npm ci --ignore-scripts，再执行 npm run check。
需要 Node.js 24+、Git 和依赖下载网络。模型和 GitHub 使用自己的账号，不含凭据。

source/LICENSE 为原创代码 MIT；改编工作流适用 Apache-2.0。
第三方来源、许可文本和 AI 辅助说明一并保留，请阅读 THIRD_PARTY_NOTICES.md。
verification.json 记录实际工程检查及依赖告警，不能代替真实模型效果评测。
注意：Zod 高危依赖告警仍存在，见 source/docs/SECURITY.md。

本 ZIP 是工程材料，不是最终技术报告和视频；后两项请按赛事要求另外提交。
在线地址安装已发布版本，源码快照包含后续文档及打包工具更新，分别按提交记录核对。
''').encode()
    files['安装地址.txt'] = ('DeepSeek Harness 0.2.1-RC3：插件 → 添加插件\n\n' + install_url + '\n\n将以上完整地址粘贴到输入框，确认来源后安装并启用，然后打开维护工作台。\n').encode()
    files['SHA256SUMS'] = ''.join(f'{digest(data)}  {name}\n' for name, data in sorted(files.items())).encode()
    out = args.out_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    target = out / f'AICOMP-opensource-workbench-{commit[:12]}{"-source" if args.source_only else ""}.zip'
    if target.exists():
        raise RuntimeError('Output already exists; choose a new output directory')
    with tempfile.NamedTemporaryFile(dir=out, suffix='.zip.tmp', delete=False) as f:
        temp = Path(f.name)
    try:
        with zipfile.ZipFile(temp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo('AICOMP-opensource-workbench/' + name, (2026, 10, 30, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                z.writestr(info, data)
        with zipfile.ZipFile(temp) as z:
            if z.testzip() is not None:
                raise RuntimeError('ZIP CRC failure')
            for entry in z.infolist():
                name = entry.filename.removeprefix('AICOMP-opensource-workbench/')
                if not safe(name) or z.read(entry) != files[name]:
                    raise RuntimeError('ZIP readback mismatch: ' + name)
        if run('git', 'rev-parse', 'HEAD').decode().strip() != commit or run('git', 'status', '--porcelain', '--untracked-files=no').strip():
            raise RuntimeError('Source changed while packaging')
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)
    checksum = digest(target.read_bytes())
    target.with_suffix('.zip.sha256').write_text(f'{checksum}  {target.name}\n')
    print(json.dumps({'archive': str(target), 'bytes': target.stat().st_size, 'sha256': checksum,
                      'commit': commit, 'files': len(files), 'tests': counts, 'audit': audit}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
