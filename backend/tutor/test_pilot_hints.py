import json
import tempfile
from pathlib import Path
from uuid import uuid4

from django.conf import settings
from django.test import TestCase, override_settings

from accounts.models import User
from courses.models import Course, Exercise, Lesson
from progress.models import ExerciseAttempt
from tutor.context import content_digest, resolve_context


class PilotHintEvidenceTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create_user('hints@example.test', 'Test-only-12345')
        self.other = User.objects.create_user('other-hints@example.test', 'Test-only-12345')
        self.course = Course.objects.create(title='Python', is_published=True)
        self.lesson = Lesson.objects.create(course=self.course, title='Types', content='Strings')
        self.exercise = Exercise.objects.create(lesson=self.lesson, title='Types', is_published=True, max_score=60)
        self.digest = content_digest(self.course, self.lesson, self.exercise)
        self.task = 'L1.types.1'
        self.answer = 'Строки соединяются, вывод 32.'
        temp = tempfile.TemporaryDirectory(dir=settings.LAT_AI_RUNTIME)
        self.addCleanup(temp.cleanup)
        mapping = Path(temp.name) / 'mapping.json'
        mapping.write_text(json.dumps({
            'version': 'test',
            'contexts': {f'{self.course.id}:{self.lesson.id}:{self.exercise.id}': {
                'lesson_key': 'L1', 'task_key': self.task, 'digest': self.digest,
            }},
        }), encoding='utf-8')
        override = override_settings(LAT_AI_MAPPING=mapping)
        override.enable()
        self.addCleanup(override.disable)

    def events(self):
        context = resolve_context({
            'action': 'hint', 'course_id': self.course.id,
            'lesson_id': self.lesson.id, 'exercise_id': self.exercise.id,
        }, self.actor)
        return context['hint_events']

    def attempt(self, *, metadata=None, **overrides):
        assessment = {
            'source': 'local_model', 'request_id': str(uuid4()), 'reason': 'ok',
            'rubric_version': 'local-assessment-v1', 'task_key': self.task,
            'content_digest': self.digest, 'checks': [True, False, True],
            'evidence': [self.answer, '', self.answer],
        }
        assessment.update(metadata or {})
        return ExerciseAttempt.objects.create(**{
            'user': self.actor, 'exercise': self.exercise, 'answer': self.answer,
            'status': 'auto_checked', 'score': 40, 'assessment': assessment,
            **overrides,
        })

    def test_valid_auto_assessment_counts_as_an_attempt_for_hint_progression(self):
        attempt = self.attempt()
        self.assertEqual(self.events(), [{
            'id': f'attempt:{attempt.id}', 'task_id': self.task, 'kind': 'attempt',
            'status': 'verified', 'passed': False,
        }])
        attempt.refresh_from_db()
        self.assertEqual(attempt.status, 'auto_checked')

    def test_stale_forged_and_other_actors_attempts_do_not_count(self):
        for metadata in (
            {'reason': 'unavailable'},
            {'source': 'client'},
            {'request_id': 'forged'},
            {'rubric_version': 'retired'},
            {'task_key': 'L1.types.2'},
            {'content_digest': 'a' * 64},
            {'checks': [True, 0, True]},
            {'evidence': ['invented quotation', '', self.answer]},
            {'evidence': [self.answer, self.answer, self.answer]},
        ):
            self.attempt(metadata=metadata)
        self.attempt(score=59)
        self.attempt(user=self.other)
        self.attempt(status='submitted')
        self.attempt(status='assessment_failed')
        self.assertEqual(self.events(), [])

    def test_human_checked_attempt_remains_valid_without_model_metadata(self):
        attempt = self.attempt(status='checked', score=60, assessment={})
        self.assertEqual(self.events(), [{
            'id': f'attempt:{attempt.id}', 'task_id': self.task, 'kind': 'attempt',
            'status': 'verified', 'passed': True,
        }])
