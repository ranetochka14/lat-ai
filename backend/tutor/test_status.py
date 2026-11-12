from unittest.mock import patch
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from accounts.models import User


class TutorStatusTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user('status@lat-ai.local', 'test-password')

    def test_status_requires_authentication(self):
        with patch('tutor.views.worker_status') as worker:
            self.assertEqual(self.client.get('/api/v1/tutor/status/').status_code, 401)
            worker.assert_not_called()

    def test_read_only_status_and_failure_do_not_expose_internal_errors(self):
        self.client.force_authenticate(self.user)
        with patch('tutor.views.worker_status', return_value={'state': 'loading', 'can_generate': False}) as worker:
            response = self.client.get('/api/v1/tutor/status/')
            self.assertEqual(response.json(), {'state': 'loading', 'can_generate': False})
            self.assertEqual(response['Cache-Control'], 'no-store')
            worker.assert_called_once_with()
        with patch('tutor.views.worker_status', side_effect=OSError('secret-path')):
            response = self.client.get('/api/v1/tutor/status/')
            self.assertEqual(response.json(), {'state': 'unavailable', 'can_generate': False})
        self.assertEqual(self.client.post('/api/v1/tutor/status/').status_code, 405)

    @override_settings(LAT_AI_CLIENT_TIMEOUT_MS=80000)
    def test_context_advertises_local_client_timeout(self):
        from courses.models import Course, Lesson
        self.client.force_authenticate(self.user)
        course = Course.objects.create(title='Local', is_published=True)
        lesson = Lesson.objects.create(course=course, title='Lesson')
        response = self.client.get(f'/api/v1/tutor/context/?course_id={course.id}&lesson_id={lesson.id}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['timeout_ms'], 80000)
