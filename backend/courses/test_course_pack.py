import importlib.util
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
import zipfile

from django.test import TestCase
from .models import Course, Lesson, Exercise

spec = importlib.util.spec_from_file_location('course_pack_import', Path(__file__).resolve().parents[2] / 'tools/import-course-pack.py')
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)


class CoursePackTests(TestCase):
    def setUp(self):
        self.existing = Course.objects.create(title='Existing course', description='Keep me')
        self.lesson = Lesson.objects.create(course=self.existing, title='Existing lesson', content='Keep text')
        self.exercise = Exercise.objects.create(lesson=self.lesson, title='Existing task', description='Keep task')
        self.catalog = [{'title': 'Imported course', 'description': 'Public theory', 'subject': 'Math',
                         'lessons': [{'title': 'Lesson', 'content': 'Public practice', 'order': 1}]}]

    def test_insert_preserves_existing_rows_and_creates_no_autoassessment(self):
        result = pack.import_courses(self.catalog)
        self.existing.refresh_from_db(); self.lesson.refresh_from_db(); self.exercise.refresh_from_db()
        self.assertEqual((self.existing.description, self.lesson.content, self.exercise.description),
                         ('Keep me', 'Keep text', 'Keep task'))
        self.assertTrue(Course.objects.get(id=result[0]['id']).is_published)
        self.assertEqual(Exercise.objects.count(), 1)
        self.assertEqual(Lesson.objects.count(), 2)

    def test_repeat_refused_without_overwrite_or_duplicates(self):
        pack.import_courses(self.catalog)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            pack.import_courses(self.catalog)
        self.assertEqual(Course.objects.count(), 2)
        self.assertEqual(Lesson.objects.count(), 2)

    def test_partial_failure_rolls_back_both_courses(self):
        second = {**self.catalog[0], 'title': 'Second imported course'}
        original = Lesson.objects.bulk_create
        calls = 0
        def fail_second(rows):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('Simulated interruption')
            return original(rows)
        with patch.object(Lesson.objects, 'bulk_create', side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError, 'Simulated'):
                pack.import_courses(self.catalog + [second])
        self.assertEqual(Course.objects.count(), 1)
        self.assertEqual(Lesson.objects.count(), 1)

    def test_runtime_reservation_is_exclusive(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(pack, 'ROOT', Path(directory)):
            target = Path(directory) / '.runtime/course-pack-test'
            self.assertEqual(pack.reserve_runtime(target), target)
            with self.assertRaises(FileExistsError):
                pack.reserve_runtime(target)

    def test_existing_external_runtime_is_never_selected(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(pack, 'ROOT', Path(directory)):
            for path in (Path(directory)/'main', Path(directory)/'.runtime/main', Path(directory)/'course-pack-test'):
                with self.assertRaisesRegex(ValueError, 'new .runtime'):
                    pack.reserve_runtime(path)
                self.assertFalse(path.exists())

    def test_unknown_archive_refused_before_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'unknown.zip'
            path.write_bytes(b'Not the reviewed archive')
            with self.assertRaisesRegex(ValueError, 'SHA'):
                pack.inspect_pack(path)

    def test_traversal_and_duplicate_members_refused_even_with_pinned_hash(self):
        import warnings
        for members in ([pack.PREFIX+'../bad.md'], [pack.PREFIX+'same.md']*2):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory)/'unsafe.zip'
                with warnings.catch_warnings(), zipfile.ZipFile(path, 'w') as archive:
                    warnings.simplefilter('ignore', UserWarning)
                    for name in members:
                        archive.writestr(name, 'text')
                with patch.object(pack, 'PACK_SHA', pack.digest(path.read_bytes())):
                    with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
                        pack.inspect_pack(path)

    def test_keys_and_guidelines_are_excluded_from_import_payload(self):
        # Complete structural fixture; no real answer-key text in the repository.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'fixture.zip'; courses=[]
            with zipfile.ZipFile(path, 'w') as archive:
                for course_id, count, folder in [('python-basics-5-9',20,'python'),('math-core-5-9',30,'math')]:
                    lessons=[]
                    for number in range(1,count+1):
                        name=f'{folder}/lessons/{number}.md'
                        archive.writestr(pack.PREFIX+name,f'# Урок {number}. Topic {number}\n\nPublic lesson')
                        lessons.append({'id':f'{course_id}-{number:02d}','number':number,'title':f'Topic {number}','file':name})
                    overview=f'{folder}/overview.md'; key=f'{folder}/assessments/key.md'
                    archive.writestr(pack.PREFIX+overview,'# Overview\n\nPublic overview')
                    archive.writestr(pack.PREFIX+key,'PRIVATE_KEY_SENTINEL')
                    courses.append({'id':course_id,'title':folder,'subject':folder,'lesson_count':count,
                                    'lessons':lessons,'overview_file':overview,'answer_keys':[key]})
                archive.writestr(pack.PREFIX+'03_IMPORT/course_catalog.json',json.dumps({'version':'3.0','courses':courses}))
                archive.writestr(pack.PREFIX+'03_IMPORT/AI_TUTOR_GUIDELINES.md','PRIVATE_GUIDELINE_SENTINEL')
            with patch.object(pack,'PACK_SHA',pack.digest(path.read_bytes())), patch.object(pack,'CORRECTIONS',[]):
                catalog, report=pack.inspect_pack(path)
            self.assertEqual(report['lessons'],50)
            self.assertNotIn('PRIVATE_',json.dumps(catalog))
            self.assertEqual(report['private_keys_imported'],0)
