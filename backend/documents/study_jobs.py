"""Durable dispatcher. Once claimed, a pack can only recover via its receipt."""
from contextlib import contextmanager
from datetime import timedelta
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from django.conf import settings
from django.db.models import F
from django.utils import timezone

from tutor.transport import NoRedirect

from .models import StudyPack
from .study_schema import InvalidStudyResult, check_result, exact_keys, strict_json

MAX_REPLY = 262_144
RECEIPT_RETRY = timedelta(seconds=5)
ERROR_CODE = re.compile(r'[a-zA-Z0-9_]{1,80}')


@contextmanager
def worker_lock():
    """Release the singleton dispatcher lock when the process exits, including on a crash."""
    lockfile = Path(settings.LAT_AI_RUNTIME) / 'study-worker.lock'
    with lockfile.open('a+b') as lock:
        lock.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        except OSError as error:
            if os.name != 'nt' or error.errno not in (13, 36):
                raise
            yield False
        else:
            yield True


def call_study(endpoint, body, resolved):
    port = settings.LAT_AI_PORT
    if type(port) is not int or not 1 <= port <= 65535:
        raise OSError('invalid_worker_configuration')
    secret = Path(settings.LAT_AI_SECRET_FILE).read_text(encoding='utf-8').strip()
    if len(secret) < 32:
        raise OSError('invalid_worker_configuration')
    data = json.dumps({'body': body, 'resolved': resolved}, ensure_ascii=True).encode('ascii')
    request = Request(
        f'http://127.0.0.1:{port}{endpoint}', data=data, method='POST',
        headers={'Content-Type': 'application/json', 'X-LAD-IPC': secret},
    )
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(request, timeout=210 if endpoint == '/study' else 5)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read(MAX_REPLY + 1)
        if len(raw) > MAX_REPLY:
            raise InvalidStudyResult('response limit')
        payload = strict_json(raw.decode('utf-8'))
        if response.status == 200:
            return payload
        if response.status in (400, 409):
            exact_keys(payload, ('status', 'result', 'error_code'))
            if payload['status'] == 'failed':
                return payload
        raise URLError('study_worker_unavailable')


def matching_packs():
    return StudyPack.objects.filter(document__owner_id=F('owner_id'))


def claim_queued():
    eligible = matching_packs().filter(status=StudyPack.Status.QUEUED)
    candidate = eligible.order_by('id').first()
    if candidate and eligible.filter(pk=candidate.pk).update(
        status=StudyPack.Status.RUNNING,
        dispatched_at=timezone.now(),
    ) == 1:
        candidate.status = StudyPack.Status.RUNNING
        return candidate
    return None


def persist(pack, status, error='', result=None, retry=False):
    # Source or owner deletion must never recreate a pack or persist orphaned grades.
    matching_packs().filter(pk=pack.pk, status=pack.status).update(
        status=status, result=result, error_code=error,
        receipt_due_at=timezone.now() + RECEIPT_RETRY if retry else None,
    )


def apply_reply(pack, reply, recovery):
    exact_keys(reply, ('status', 'result', 'error_code'))
    status, result, error = reply['status'], reply['result'], reply['error_code']
    if type(status) is not str or status not in ('ready', 'failed', 'unknown', 'pending', 'missing'):
        raise InvalidStudyResult('invalid worker status')
    if error is not None and (type(error) is not str or ERROR_CODE.fullmatch(error) is None):
        raise InvalidStudyResult('invalid worker error')
    if status == 'ready':
        if error is not None:
            raise InvalidStudyResult('unexpected worker error')
        check_result(result, pack.mode, pack.source_text)
        persist(pack, StudyPack.Status.READY, result=result)
        return False
    if result is not None:
        raise InvalidStudyResult('unexpected worker result')
    if status == 'failed':
        persist(pack, StudyPack.Status.FAILED, error or 'generation_failed')
        return False
    if status == 'unknown':
        persist(pack, StudyPack.Status.UNKNOWN, error or 'generation_unknown')
        return False
    if not recovery or error is not None:
        raise InvalidStudyResult('invalid receipt')
    if status == 'missing':
        persist(pack, StudyPack.Status.UNKNOWN, 'receipt_missing')
        return False
    if pack.status == StudyPack.Status.UNKNOWN:
        persist(pack, pack.status, 'worker_unreachable', retry=True)
    return True


def process_pack(pack, recovery=False):
    body = {'request_id': str(pack.request_id), 'mode': pack.mode, 'source_text': pack.source_text}
    endpoint = '/study/receipt' if recovery else '/study'
    try:
        reply = call_study(endpoint, body, {'actor_id': str(pack.owner_id)})
        return apply_reply(pack, reply, recovery)
    except (OSError, HTTPException):
        persist(pack, StudyPack.Status.UNKNOWN, 'worker_unreachable', retry=True)
    except (ValueError, RecursionError):
        persist(pack, StudyPack.Status.FAILED, 'invalid_result')
    return False


def work_once():
    """Process one queue item, after reconciling any earlier dispatch."""
    running = matching_packs().filter(status=StudyPack.Status.RUNNING).order_by('id').first()
    if running:
        pending = process_pack(running, recovery=True)
        return not pending

    unknown = matching_packs().filter(
        status=StudyPack.Status.UNKNOWN, receipt_due_at__lte=timezone.now(),
    ).order_by('receipt_due_at', 'id').first()
    if unknown:
        if process_pack(unknown, recovery=True):
            return False

    pack = claim_queued()
    if pack is None:
        return False
    process_pack(pack)
    return True
