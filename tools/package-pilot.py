"""Create and verify a source-only pilot ZIP; never include runtime/user data."""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRS = {'.git', '.runtime', '.venv', 'venv', 'env', 'node_modules', '__pycache__',
                 '.superpowers', 'media', 'staticfiles', '.pytest_cache', '.mypy_cache', '.ruff_cache'}
EXCLUDED_SUFFIXES = {'.pyc', '.pyo', '.sqlite3', '.db', '.log', '.jsonl', '.gguf', '.pem', '.key', '.zip', '.bak'}


def source_files():
    files = []
    for directory, folders, names in os.walk(ROOT, followlinks=False):
        folders[:] = sorted(name for name in folders if name not in EXCLUDED_DIRS and not (Path(directory)/name).is_symlink())
        for name in sorted(names):
            path = Path(directory) / name
            if path.is_symlink() or name in {'.git', 'MANIFEST.json'} or path.suffix.lower() in EXCLUDED_SUFFIXES:
                continue
            if name.startswith('.env') and name != '.env.example':
                continue
            if any(part in name.lower() for part in ('ipc-secret', 'django-secret', 'private-key')):
                continue
            files.append(path)
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit('Refusing to overwrite existing release archive.')
    files = source_files()
    entries = []
    for path in files:
        data = path.read_bytes()
        entries.append({'path': path.relative_to(ROOT).as_posix(), 'bytes': len(data), 'sha256': sha256(data).hexdigest()})
    manifest = {'format': 1, 'release': 'LAT AI document pilot 2026-11-11',
                'kind': 'source-only; install requirements; use existing local model separately', 'files': entries}
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for item, path in zip(entries, files):
            archive.write(path, 'LAT-AI-Document-Pilot/' + item['path'])
        archive.writestr('LAT-AI-Document-Pilot/MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8'))
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or len(archive.namelist()) != len(entries) + 1:
            raise ValueError('Archive CRC or entry-count verification failed')
        for item in entries:
            data = archive.read('LAT-AI-Document-Pilot/' + item['path'])
            if len(data) != item['bytes'] or sha256(data).hexdigest() != item['sha256']:
                raise ValueError('Archive content verification failed: ' + item['path'])
        if not all('..' not in Path(name).parts and not Path(name).is_absolute() for name in archive.namelist()):
            raise ValueError('Archive contains an unsafe path')
    verification = {'archive': output.name, 'bytes': output.stat().st_size,
                    'sha256': sha256(output.read_bytes()).hexdigest(), 'source_files': len(entries),
                    'verified_entries': len(entries) + 1, 'crc_and_all_sha256': True,
                    'runtime_databases_secrets_models_included': False}
    output.with_suffix('.verification.json').write_text(json.dumps(verification, indent=2), encoding='utf-8')
    print(json.dumps(verification, indent=2))


if __name__ == '__main__':
    main()
