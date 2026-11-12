import json
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from urllib.error import HTTPError
from django.conf import settings

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def call_worker(body, resolved):
    return _call(body, resolved, '/ask')

def call_assessment(body, resolved):
    return _call(body, resolved, '/assess')

def _call(body, resolved, endpoint):
    port = getattr(settings,'LAT_AI_PORT',8372)
    if type(port) is not int or not 1 <= port <= 65535:
        raise RuntimeError('invalid worker configuration')
    secret = Path(settings.LAT_AI_SECRET_FILE).read_text(encoding='utf-8').strip()
    if len(secret) < 32:
        raise RuntimeError('worker not configured')
    request = Request(f'http://127.0.0.1:{port}{endpoint}', data=json.dumps({'body':body,'resolved':resolved},ensure_ascii=True).encode('ascii'),
                      headers={'Content-Type':'application/json','X-LAT-IPC':secret},method='POST')
    opener = build_opener(ProxyHandler({}),NoRedirect())
    try:
        response = opener.open(request,timeout=9)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read(1048577)
        if len(raw)>1048576:
            raise RuntimeError('worker response limit')
        result = json.loads(raw)
        if not isinstance(result,dict) or result.get('contract_version') != '1.0' or result.get('request_id') not in (None,body['request_id']):
            raise RuntimeError('worker protocol')
        return response.status,result
