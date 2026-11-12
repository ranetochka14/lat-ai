"""Explicit local installation with a consistent backup before any database write."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from courses.bundled import install_catalog, load_catalog


class Command(BaseCommand):
    help = 'Install reviewed school courses without overwriting existing courses or attempts.'

    def add_arguments(self, parser):
        parser.add_argument('--backup-dir', required=True, help='New directory outside the runtime; never reused.')

    def handle(self, *args, **options):
        catalog = load_catalog()
        config = settings.DATABASES['default']
        if config['ENGINE'] != 'django.db.backends.sqlite3':
            raise CommandError('This installer supports the local SQLite pilot only.')
        database = Path(config['NAME']).resolve()
        destination = Path(options['backup_dir']).resolve()
        if not database.is_file() or destination.is_relative_to(database.parent):
            raise CommandError('Existing database and a new backup directory outside its runtime are required.')
        destination.mkdir(parents=True, exist_ok=False)
        backup = destination / 'django.sqlite3'
        report = {'database': str(database), 'backup': str(backup), 'status': 'backing_up'}
        try:
            with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as source:
                with closing(sqlite3.connect(backup)) as target:
                    source.backup(target)
                    if target.execute('PRAGMA quick_check').fetchone() != ('ok',):
                        raise CommandError('Backup integrity check failed; import cancelled.')
            report['backup_sha256'] = hashlib.sha256(backup.read_bytes()).hexdigest()
            report['courses'] = install_catalog(catalog)
            report['status'] = 'complete'
        except Exception as error:
            report.update(status='failed', error=str(error))
            raise CommandError(str(error)) from error
        finally:
            (destination / 'installation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
