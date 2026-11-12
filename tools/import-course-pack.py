"""Review the pinned school pack, or import it into a BRAND NEW isolated runtime.

No archive code is executed. Answer keys and tutor guidelines are never imported.
Existing runtime directories are refused, including after a failed import.
"""
import argparse
import ast
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import stat
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACK_SHA = '10bbe18017a81694b265521290bebaf838c6cce3237016bd835cf24ee3e41be4'
PREFIX = 'LAT_AI_COURSES_GRADES_5_9/'
NOTICE = ('Пилотный учебный материал для самостоятельной работы. Практические задания '
          'находятся в тексте уроков; автоматическая проверка и баллы для этого курса '
          'пока не подключены. Используй вымышленные имена и учебные данные, '
          'не вводи настоящие пароли. ИИ может ошибаться.\n\n')

# Reviewed corrections apply only to this exact archive. Original bytes remain intact.
CORRECTIONS = [
    ('python-basics-5-9', 3, 'Имена пишут латиницей без пробелов: `user_name`.',
     'В примерах используем имена латиницей без пробелов: `user_name`. Python также допускает многие буквы Unicode в именах.'),
    ('python-basics-5-9', 4, '`//` (целая часть деления)',
     '`//` (деление с округлением вниз, к минус бесконечности: `7 // 3 = 2`, `-7 // 3 = -3`)'),
    ('python-basics-5-9', 6,
     'Если написать `if score >= 50` раньше `if score >= 90`, то для 95 выполнится первая подходящая ветка и более точная оценка может не провериться.',
     'В одной цепочке `if/elif/else`, если начать с `if score >= 50`, а затем написать `elif score >= 90`, для 95 выполнится первая ветка, а условие второй уже не проверится. У двух отдельных операторов `if` проверяются оба условия.'),
    ('python-basics-5-9', 13, 'Найди второй по величине элемент, обработав повторяющиеся значения.',
     'Найди второй элемент при сортировке по убыванию, учитывая повторения: для [5, 5, 3] ответ 5. Предусмотри случай, когда элементов меньше двух.'),
    ('math-core-5-9', 2, 'Чтобы проверить, простое ли число n, достаточно проверить делители от 2 до √n:',
     'Для натурального числа n > 1 достаточно проверить целые делители от 2 до √n включительно:'),
    ('math-core-5-9', 13, 'Вероятность 0 означает невозможное событие, 1 — достоверное.',
     'В рассматриваемой конечной модели с равновозможными исходами вероятность 0 означает невозможное событие, 1 — достоверное.'),
    ('math-core-5-9', 15, 'Проверь, можно ли безопасно поставить лестницу длиной 5 м на расстоянии 3 м от стены: высота опоры равна 4 м.',
     'В геометрической модели лестница длиной 5 м опирается на стену, перпендикулярную земле; её основание находится в 3 м от стены. Найди высоту опоры: она равна 4 м. Этот расчёт не определяет безопасность установки лестницы.'),
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect_pack(path):
    path = Path(path)
    if path.stat().st_size > 5_000_000:
        raise ValueError('Archive too large')
    raw = path.read_bytes()
    if digest(raw) != PACK_SHA:
        raise ValueError('Archive SHA differs from the reviewed pack; a new review is required')
    files = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) > 150 or sum(i.file_size for i in infos) > 5_000_000:
            raise ValueError('Archive bounds exceeded')
        seen = set()
        for info in infos:
            name = info.filename
            parts = PurePosixPath(name).parts
            if (name in seen or not name.startswith(PREFIX) or '\\' in name
                    or '..' in parts or ':' in name or PurePosixPath(name).is_absolute()
                    or stat.S_ISLNK(info.external_attr >> 16)):
                raise ValueError('Unsafe or duplicate archive member')
            seen.add(name)
            if info.is_dir():
                continue
            if info.file_size > 300_000 or not name.endswith(('.md', '.json')):
                raise ValueError('Unexpected member type or size')
            data = archive.read(info)  # also checks CRC; never extracts or executes
            files[name[len(PREFIX):]] = data
    texts = {name: data.decode('utf-8-sig') for name, data in files.items()}
    catalog = json.loads(texts['03_IMPORT/course_catalog.json'])
    if catalog['version'] != '3.0' or len(catalog['courses']) != 2:
        raise ValueError('Unexpected catalog version')
    result = []
    used = set()
    corrections = []
    code_blocks = 0
    title_repairs = []
    for source in catalog['courses']:
        expected = {'python-basics-5-9': 20, 'math-core-5-9': 30}[source['id']]
        if source['lesson_count'] != expected or len(source['lessons']) != expected:
            raise ValueError('Lesson count mismatch')
        lessons = []
        for number, lesson in enumerate(source['lessons'], 1):
            name = lesson['file']
            if (lesson['number'] != number or lesson['id'] != f"{source['id']}-{number:02d}"
                    or name in used or '/lessons/' not in name):
                raise ValueError('Duplicate or unordered lesson')
            used.add(name)
            original = content = texts[name]
            heading = re.match(r'# Урок \d+\. (.+)', content)
            if not heading:
                raise ValueError('Missing lesson title')
            title = heading[1].strip()
            if title != lesson['title']:
                title_repairs.append({'file': name, 'catalog': lesson['title'], 'title': title})
            for course_id, lesson_number, old, new in CORRECTIONS:
                if (source['id'], number) == (course_id, lesson_number):
                    if content.count(old) != 1:
                        raise ValueError('Correction no longer matches the reviewed source')
                    content = content.replace(old, new, 1)
                    corrections.append({'file': name, 'before': old, 'after': new})
            for code in re.findall(r'```python\s*\n(.*?)```', content, re.S):
                ast.parse(code)  # syntax only; NEVER eval/exec/import source examples
                code_blocks += 1
            # H1 is rendered by the lesson page already.
            content = NOTICE + content.split('\n', 1)[1].lstrip()
            lessons.append({'title': title, 'order': number, 'content': content,
                            'file': name, 'source_sha256': digest(files[name]),
                            'imported_sha256': digest(content.encode('utf-8'))})
        for key in source['answer_keys']:
            if '/assessments/' not in key or key not in files:
                raise ValueError('Missing private answer key')
        overview = texts[source['overview_file']]
        if overview.startswith('# '):
            overview = overview.split('\n', 1)[1].lstrip()
        result.append({'id': source['id'], 'title': source['title'],
                       'subject': 'Программирование' if source['subject'] == 'programming' else 'Математика',
                       'description': NOTICE + overview, 'lessons': lessons})
    if used != {n for n in files if '/lessons/' in n} or len(corrections) != len(CORRECTIONS):
        raise ValueError('Unreferenced lessons or incomplete corrections')
    return result, {'archive_sha256': PACK_SHA, 'files': len(files),
                    'uncompressed_bytes': sum(map(len, files.values())),
                    'members': {n: digest(b) for n, b in sorted(files.items())},
                    'lessons': len(used), 'python_blocks_syntax_checked': code_blocks,
                    'corrections': corrections, 'title_repairs': title_repairs,
                    'lesson_sources': [{k: lesson[k] for k in ('file', 'source_sha256', 'imported_sha256')}
                                       for course in result for lesson in course['lessons']],
                    'private_keys_imported': 0, 'model_requests': 0}


def import_courses(catalog):
    """Insert only, in one transaction. Collision or failure never rewrites rows."""
    from django.db import transaction
    from courses.models import Course, Lesson
    with transaction.atomic():
        if Course.objects.filter(title__in=[c['title'] for c in catalog]).exists():
            raise ValueError('Course title already exists; no update or duplicate import allowed')
        created = []
        for item in catalog:
            course = Course.objects.create(title=item['title'], description=item['description'],
                                           subject=item['subject'], is_published=True)
            rows = [Lesson(course=course, title=lesson['title'], content=lesson['content'], order=lesson['order'])
                    for lesson in item['lessons']]
            Lesson.objects.bulk_create(rows)
            created.append({'id': course.id, 'title': course.title,
                            'lessons': [{'id': row.id, 'title': row.title, 'order': row.order} for row in rows]})
    return created


def reserve_runtime(value):
    runtime = Path(value).resolve()
    if runtime.parent != (ROOT / '.runtime').resolve() or not runtime.name.startswith('course-pack-'):
        raise ValueError('Use a new .runtime/course-pack-* directory in this checkout')
    runtime.parent.mkdir(exist_ok=True)
    runtime.mkdir(exist_ok=False)  # exclusive reservation; also refuses an empty existing dir
    return runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive')
    parser.add_argument('--runtime', help='Omit for read-only inspection. Must not already exist.')
    parser.add_argument('--report', required=True, help='New JSON report; existing files are refused.')
    args = parser.parse_args()
    catalog, report = inspect_pack(args.archive)
    report_path = Path(args.report).resolve()
    # Reserve output before any database work, so inability to save evidence fails early.
    with report_path.open('x', encoding='utf-8') as output:
        report['status'] = 'checked'
        try:
            if args.runtime:
                runtime = reserve_runtime(args.runtime)
                report['runtime'] = str(runtime)
                os.environ.update(DJANGO_SETTINGS_MODULE='config.ai_local', LAT_AI_RUNTIME=str(runtime))
                os.environ.pop('LAT_AI_TEST', None)
                sys.path.insert(0, str(ROOT / 'backend'))
                runpy.run_path(str(ROOT / 'tools/prepare-ai.py'), run_name='__main__')
                from django.conf import settings
                if Path(settings.DATABASES['default']['NAME']).resolve() != runtime / 'django.sqlite3':
                    raise ValueError('Isolated database identity mismatch')
                from courses.models import Course, Lesson, Exercise
                before = {model.__name__: list(model.objects.values()) for model in (Course, Lesson, Exercise)}
                report['created'] = import_courses(catalog)
                for model in (Course, Lesson, Exercise):
                    previous = before[model.__name__]
                    if list(model.objects.filter(id__in=[r['id'] for r in previous]).values()) != previous:
                        raise RuntimeError('Baseline rows changed')
                report['baseline_rows_preserved'] = {k: len(v) for k, v in before.items()}
                report['status'] = 'imported'
        except BaseException as error:
            report.update(status='failed', error=f'{type(error).__name__}: {error}')
            raise
        finally:
            json.dump(report, output, ensure_ascii=False, indent=2)
    print(json.dumps({'status': report['status'], 'courses': len(catalog), 'lessons': report['lessons'],
                      'report': str(report_path)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
