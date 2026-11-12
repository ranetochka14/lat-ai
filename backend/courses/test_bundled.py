from unittest.mock import patch

from django.test import TestCase
from .bundled import install_catalog, load_catalog
from .models import Course, Lesson, Exercise


class BundledCoursesTests(TestCase):
    def test_all_reviewed_lessons_are_published_and_repeat_keeps_ids(self):
        existing = Course.objects.create(title='Original', description='Do not change')
        first = install_catalog()
        ids = list(Lesson.objects.values_list('id', flat=True))
        second = install_catalog()
        self.assertEqual([r['id'] for r in first], [r['id'] for r in second])
        self.assertEqual(list(Lesson.objects.values_list('id', flat=True)), ids)
        self.assertEqual(Course.objects.filter(is_published=True).count(), 2)
        self.assertEqual(len(ids), 50)
        self.assertEqual(Exercise.objects.count(), 0)
        self.assertTrue(all(r['status'] == 'already_installed' for r in second))
        existing.refresh_from_db()
        self.assertEqual(existing.description, 'Do not change')

    def test_edited_lesson_is_not_overwritten_and_no_other_course_is_inserted(self):
        catalog = load_catalog()
        install_catalog([catalog[1]])
        lesson = Lesson.objects.first()
        lesson.content = 'Teacher revision'
        lesson.save()
        with self.assertRaisesRegex(ValueError, 'collision'):
            install_catalog()  # first course must also roll back
        lesson.refresh_from_db()
        self.assertEqual(lesson.content, 'Teacher revision')
        self.assertEqual(Course.objects.count(), 1)

    def test_duplicate_title_is_not_mistaken_for_a_matching_installation(self):
        install_catalog()
        Course.objects.create(title=load_catalog()[0]['title'])
        with self.assertRaisesRegex(ValueError, 'collision'):
            install_catalog()

    def test_partial_failure_rolls_back(self):
        with patch.object(Lesson.objects, 'bulk_create', side_effect=RuntimeError('interrupted')):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                install_catalog()
        self.assertEqual(Course.objects.count(), 0)

    def test_changed_bundle_is_refused_before_database_writes(self):
        with patch('courses.bundled.BUNDLE_SHA256', '0' * 64):
            with self.assertRaisesRegex(ValueError, 'checksum'):
                install_catalog()
        self.assertEqual(Course.objects.count(), 0)
