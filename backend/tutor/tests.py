import json
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch
from django.test import TestCase, override_settings
from django.conf import settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken
from accounts.models import User
from courses.models import Course, Lesson, Exercise

class TutorBoundaryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('adult@example.test', 'Test-only-12345')
        self.course = Course.objects.create(title='Python', is_published=True)
        self.lesson = Lesson.objects.create(course=self.course, title='Типы', content='Строки и числа')
        self.exercise = Exercise.objects.create(lesson=self.lesson, title='Строки', description='Объясни print("3" + "2")')
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(RefreshToken.for_user(self.user).access_token))
        self.body = dict(contract_version='1.0', request_id=str(uuid.uuid4()), action='explain', question='Почему так?', course_id=self.course.id, lesson_id=self.lesson.id, exercise_id=self.exercise.id, code_context={'code':'print("3" + "2")','revision':1,'selection':{'start':0,'end':5}})
        self.directory = tempfile.TemporaryDirectory(dir=settings.LAT_AI_RUNTIME)
        self.addCleanup(self.directory.cleanup)
        self.mapping = Path(self.directory.name) / 'mapping.json'
        self.override = override_settings(LAT_AI_MAPPING=self.mapping)
        self.override.enable(); self.addCleanup(self.override.disable)

    def test_authenticated_request_is_connected_not_501(self):
        with patch('tutor.views.call_worker', create=True, return_value=(200, {'answer':{'text':'Тестовая заглушка транспорта'}})) as worker:
            response = self.client.post('/api/v1/tutor/ask/', self.body, format='json')
        self.assertEqual(response.status_code, 200)
        sent, resolved = worker.call_args.args
        self.assertEqual(sent['code_context'], self.body['code_context'])
        self.assertEqual(resolved['actor_id'], self.user.id)
        self.assertEqual(resolved['access'], 'granted')

    def test_auth_unknown_fields_and_cross_resource_do_not_call_worker(self):
        with patch('tutor.views.call_worker', create=True) as worker:
            anon = APIClient().post('/api/v1/tutor/ask/', self.body, format='json')
            self.assertEqual(anon.status_code, 401)
            for extra in ({'user_id':42}, {'lesson_id':True}, {'course_id':999999}):
                response = self.client.post('/api/v1/tutor/ask/', {**self.body, **extra}, format='json')
                self.assertIn(response.status_code, (400,404))
            worker.assert_not_called()

    def test_unpublished_course_is_denied_before_replay(self):
        self.course.is_published=False;self.course.save()
        with patch('tutor.views.call_worker', create=True) as worker:
            response=self.client.post('/api/v1/tutor/ask/', self.body, format='json')
        self.assertEqual(response.status_code,404);worker.assert_not_called()

    def test_mapping_binds_content_and_pending_attempts_are_not_verified(self):
        from tutor.context import content_digest
        from progress.models import ExerciseAttempt
        record={'lesson_key':'L1','topic':'types','task_key':'L1.types.1','digest':content_digest(self.course,self.lesson,self.exercise),'initial_code':'print("3" + "2")'}
        self.mapping.write_text(json.dumps({'version':'i02-v1','contexts':{f'{self.course.id}:{self.lesson.id}:{self.exercise.id}':record}}),encoding='utf-8')
        ExerciseAttempt.objects.create(user=self.user,exercise=self.exercise,answer='test',status='submitted')
        with patch('tutor.views.call_worker', create=True, return_value=(200,{})) as worker:
            self.client.post('/api/v1/tutor/ask/', self.body, format='json')
            self.assertEqual(worker.call_args.args[1]['task_key'],'L1.types.1')
            self.assertEqual(worker.call_args.args[1]['hint_events'],[])
            self.exercise.description='Изменённое условие';self.exercise.save()
            self.client.post('/api/v1/tutor/ask/', self.body, format='json')
            self.assertIsNone(worker.call_args.args[1]['lesson_key'])

    def test_worker_failure_is_safe_error_and_body_limit(self):
        with patch('tutor.views.call_worker', create=True, side_effect=RuntimeError('secret-test-exception')):
            response=self.client.post('/api/v1/tutor/ask/', self.body, format='json')
        self.assertEqual(response.status_code,503)
        self.assertNotIn('secret-test-exception',response.content.decode())
        large=self.client.post('/api/v1/tutor/ask/',{**self.body,'question':'x'*50000},format='json')
        self.assertEqual(large.status_code,413)

    def test_lone_surrogates_fail_contract_before_utf8_transport(self):
        with patch('tutor.views.call_worker', create=True, side_effect=RuntimeError('would reach transport')) as worker:
            question=self.client.post('/api/v1/tutor/ask/', json.dumps({**self.body,'question':'why\ud800'}), content_type='application/json')
            code=self.client.post('/api/v1/tutor/ask/', json.dumps({**self.body,'code_context':{'code':'x=\ud800','revision':1,'selection':None}}), content_type='application/json')
        self.assertEqual(question.status_code,400)
        self.assertEqual(code.status_code,400)
        self.assertEqual(code.json()['error']['code'],'INVALID_CODE_CONTEXT')
        worker.assert_not_called()
