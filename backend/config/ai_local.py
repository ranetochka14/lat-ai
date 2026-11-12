"""Isolated manual AI profile; production PostgreSQL settings stay unchanged."""
from .settings import *

LAT_AI_RUNTIME = Path(os.environ.get('LAT_AI_RUNTIME', BASE_DIR.parent / '.runtime' / 'i02')).resolve()
LAT_AI_RUNTIME.mkdir(parents=True, exist_ok=True)
if os.environ.get('LAT_AI_TEST') == '1':
    SECRET_KEY = 'isolated-integration-tests-only-not-a-deployment-key'
else:
    SECRET_KEY = (LAT_AI_RUNTIME / 'django-secret.txt').read_text(encoding='utf-8').strip()
DEBUG = False
# Avoid autodiscover of document/RAG admin modules in this minimal profile.
INSTALLED_APPS = ['django.contrib.admin.apps.SimpleAdminConfig' if app == 'django.contrib.admin' else app for app in INSTALLED_APPS]
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': LAT_AI_RUNTIME / 'django.sqlite3', 'OPTIONS': {'timeout': 10}}}
ROOT_URLCONF = 'config.ai_local_urls'
ALLOWED_HOSTS = ['127.0.0.1', 'localhost', 'testserver']
LAT_AI_MAPPING = LAT_AI_RUNTIME / 'mapping.json'
LAT_AI_SECRET_FILE = LAT_AI_RUNTIME / 'ipc-secret.txt'
LAT_AI_PORT = int(os.environ.get('LAT_AI_PORT', '8372'))
LAT_FRONTEND_PORT = int(os.environ.get('LAT_FRONTEND_PORT', '5173'))
CORS_ALLOWED_ORIGINS = [f'http://{host}:{LAT_FRONTEND_PORT}' for host in ('localhost', '127.0.0.1')]
MEDIA_ROOT = LAT_AI_RUNTIME / 'private-media'
LAT_AI_AUTOGRADE = True
LAT_AI_STUDY_BUDGET_MS = int(os.environ.get('LAT_AI_STUDY_BUDGET_MS', '180000'))
if not 180000 <= LAT_AI_STUDY_BUDGET_MS <= 900000:
    raise ValueError('Invalid local study budget')
LAT_AI_MODEL_BUDGET_MS = int(os.environ.get('LAT_AI_MODEL_BUDGET_MS', '7900'))
if not 1 <= LAT_AI_MODEL_BUDGET_MS <= 60000:
    raise ValueError('Invalid local AI time budget')
LAT_AI_TRANSPORT_SECONDS = 9 if LAT_AI_MODEL_BUDGET_MS <= 7900 else LAT_AI_MODEL_BUDGET_MS / 1000 + 10
LAT_AI_CLIENT_TIMEOUT_MS = 10000 if LAT_AI_MODEL_BUDGET_MS <= 7900 else LAT_AI_MODEL_BUDGET_MS + 20000
DATA_UPLOAD_MAX_MEMORY_SIZE = 49152
PASSWORD_HASHERS = ['django.contrib.auth.hashers.PBKDF2PasswordHasher']

# Third-party parser diagnostics can contain input data.
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'ignore_pdf_diagnostics': {'class': 'logging.NullHandler'}},
    'loggers': {'pypdf': {'handlers': ['ignore_pdf_diagnostics'], 'propagate': False}},
}