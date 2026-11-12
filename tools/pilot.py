"""Local pilot entry point. Own processes only; never stop the shared LM runtime."""
import argparse
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import subprocess
import sys
import time
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def configure(args):
    if args.python_extra_site:
        extra_site = Path(args.python_extra_site).resolve()
        if not extra_site.is_dir():
            raise RuntimeError('Extra Python dependency directory does not exist.')
        # Optional developer adapter: prefer this interpreter's installed libraries.
        sys.path.append(str(extra_site))
    runtime = Path(args.runtime or ROOT / '.runtime' / 'pilot').resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    os.environ.update(DJANGO_SETTINGS_MODULE='config.ai_local', LAT_AI_RUNTIME=str(runtime),
                      LAT_AI_PORT=str(args.worker_port), LAT_FRONTEND_PORT=str(args.site_port),
                      PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONNOUSERSITE='1')
    os.environ.pop('LAT_AI_TEST', None)
    return runtime


def prepare():
    runpy.run_path(str(ROOT / 'tools' / 'prepare-ai.py'), run_name='__main__')


def ipc(runtime, port, action=None, timeout=5):
    secret = (runtime / 'ipc-secret.txt').read_text(encoding='utf-8').strip()
    data = json.dumps({'action': action}).encode() if action else None
    req = Request(f'http://127.0.0.1:{port}/' + ('control' if action else 'health'), data=data,
                  headers={'Content-Type': 'application/json', 'X-LAT-IPC': secret})
    with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=timeout) as response:
        return json.load(response)


def available(port):
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
        except OSError as error:
            raise RuntimeError(f'Port {port} unavailable; existing service was not stopped.') from error


def prepare_safe():
    # Historical prepare script exits 0 when seed exists; continue launching.
    try:
        prepare()
    except SystemExit as error:
        if error.code not in (0, None):
            raise


def run(args, runtime):
    ports = [args.api_port, args.site_port, args.worker_port]
    if len(set(ports)) != 3:
        raise RuntimeError('API, site and worker ports must differ.')
    for port in ports:
        available(port)
    node = args.node or str(ROOT / '.runtime' / 'node' / 'node.exe')
    if not Path(node).is_file():
        node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js 22.13+ required. See README-PILOT.txt.')
    if args.enable_model and not shutil.which('lms'):
        raise RuntimeError('LM Studio CLI (lms) must be available in PATH. See README-PILOT.txt.')
    prepare_safe()
    commands = {
        'worker': [node, args.worker_script or 'integration/ai/worker.mjs'],
        'django': [sys.executable, '-B', 'tools/pilot.py', *common_args(args), 'manage', 'runserver', f'127.0.0.1:{args.api_port}', '--noreload'],
        'jobs': [sys.executable, '-B', 'tools/pilot.py', *common_args(args), 'manage', 'run_study_jobs'],
        'site': [node, 'server.cjs'],
    }
    processes, handles = {}, []
    stamp = time.strftime('%Y%m%d-%H%M%S')
    logdir = runtime / 'logs' / stamp
    logdir.mkdir(parents=True, exist_ok=True)
    enabled = False
    try:
        for name, command in commands.items():
            log = (logdir / f'{name}.log').open('ab')
            handles.append(log)
            processes[name] = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        (runtime / 'pilot-processes.json').write_text(json.dumps({'started': stamp, 'root': str(ROOT),
            'processes': {key: value.pid for key, value in processes.items()}, 'ports': ports}, indent=2), encoding='utf-8')
        deadline = time.monotonic() + 30
        while True:
            if any(p.poll() is not None for p in processes.values()):
                raise RuntimeError(f'Pilot process exited; see {logdir}')
            try:
                ipc(runtime, args.worker_port)
                # An HTTP 401 proves authenticated API is serving, not just port bound.
                from urllib.error import HTTPError
                try:
                    build_opener(ProxyHandler({})).open(f'http://127.0.0.1:{args.api_port}/api/v1/documents/', timeout=2)
                except HTTPError as error:
                    if error.code != 401:
                        raise
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError(f'Pilot startup timeout; see {logdir}')
                time.sleep(.5)
        if args.enable_model:
            # LM Studio must already serve the existing local model files. No downloads.
            ipc(runtime, args.worker_port, 'enable', 150)
            enabled = True
        print(f'LAT AI: http://127.0.0.1:{args.site_port}/#/documents', flush=True)
        print(f'API: http://127.0.0.1:{args.api_port}/api/v1 | Admin: http://127.0.0.1:{args.api_port}/admin/', flush=True)
        print(f'Logs: {logdir}\nStop with Ctrl+C. Other services are never stopped.', flush=True)
        while all(p.poll() is None for p in processes.values()):
            time.sleep(.5)
        raise RuntimeError(f'Pilot process stopped unexpectedly; see {logdir}')
    except KeyboardInterrupt:
        print('Stopping this pilot...', flush=True)
    finally:
        if enabled:
            try:
                ipc(runtime, args.worker_port, 'retire', 15)
            except Exception:
                print('Owned model retirement not confirmed. Keep runtime lock/logs; see README recovery.', flush=True)
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
        for process in processes.values():
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
        for handle in handles:
            handle.close()


def common_args(args):
    return ['--runtime', str(Path(args.runtime or ROOT / '.runtime' / 'pilot').resolve()),
            '--worker-port', str(args.worker_port), '--site-port', str(args.site_port), '--api-port', str(args.api_port),
            *(['--python-extra-site', args.python_extra_site] if args.python_extra_site else [])]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime')
    parser.add_argument('--node')
    parser.add_argument('--worker-script', help=argparse.SUPPRESS)
    parser.add_argument('--python-extra-site', help='Optional existing dependency directory, appended after interpreter libraries')
    for name, default in [('api', 8000), ('site', 5173), ('worker', 8372)]:
        parser.add_argument(f'--{name}-port', type=int, choices=range(1, 65536), default=default, metavar='PORT')
    parser.add_argument('--enable-model', action='store_true')
    parser.add_argument('command', choices=['prepare', 'run', 'manage', 'model'])
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    runtime = configure(args)
    if args.command == 'run':
        run(args, runtime)
    elif args.command == 'prepare':
        prepare_safe()
    elif args.command == 'manage':
        from django.core.management import execute_from_command_line
        execute_from_command_line(['manage.py', *args.arguments])
    else:
        action = args.arguments[0] if args.arguments else 'status'
        if action not in ('status', 'enable', 'disable', 'retire'):
            raise RuntimeError('Model action: status/enable/disable/retire')
        print(json.dumps(ipc(runtime, args.worker_port, None if action == 'status' else action, 150), indent=2))


if __name__ == '__main__':
    main()
