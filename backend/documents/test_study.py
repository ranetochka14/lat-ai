import tempfile
from pathlib import Path
from uuid import uuid4

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User

BASE = '/api/v1/documents/'
QUOTE = 'A verbatim sentence from the text.'
SOURCE = '🌐 ' + (QUOTE + ' ') * 5


class StudyApiFixture:
    def setUp(self):
        self.user = User.objects.create_user('study@example.test', 'test-only-password')
        self.other = User.objects.create_user('other@example.test', 'test-only-password')
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        folder = tempfile.TemporaryDirectory(dir=settings.LAT_AI_RUNTIME)
        self.addCleanup(folder.cleanup)
        override = override_settings(MEDIA_ROOT=Path(folder.name))
        override.enable()
        self.addCleanup(override.disable)

    def upload(self, data=SOURCE.encode(), name='source.txt'):
        return self.client.post(BASE, {
            'file': SimpleUploadedFile(name, data, content_type='text/plain'),
        }, format='multipart')

    def generate(self, url, **changes):
        body = dict(request_id=str(uuid4()), mode='test', source_start=2, source_end=len(SOURCE))
        return self.client.post(url + 'generate/', {**body, **changes}, format='json')


class StudyApiTests(StudyApiFixture, TestCase):
    def test_upload_and_owner_only_original(self):
        created = self.upload()
        self.assertEqual(created.status_code, 201)
        self.assertNotIn('file', created.data)
        self.assertEqual(created.data['text_length'], len(SOURCE))
        url = BASE + str(created.data['id']) + '/'
        self.assertEqual(self.client.get(url).data['extracted_text'], SOURCE)
        downloaded = self.client.get(url + 'download/')
        self.assertEqual(b''.join(downloaded.streaming_content), SOURCE.encode())
        downloaded.close()
        self.client.force_authenticate(self.other)
        for suffix in ('', 'download/'):
            self.assertEqual(self.client.get(url + suffix).status_code, 404)
        self.assertEqual(self.generate(url).status_code, 404)
        self.assertEqual(self.client.delete(url).status_code, 404)

    def test_invalid_upload_has_no_partial_text(self):
        for data in (b'\xff', b' ', b'a' * 200001):
            response = self.upload(data)
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.data['status'], 'failed')
            self.assertEqual(response.data['text_length'], 0)
            self.assertTrue(response.data['error'])
        self.assertEqual(self.upload(b'unsupported', 'bad.exe').status_code, 400)

    def test_generation_idempotency_and_active_delete(self):
        document = self.upload().data['id']
        url = BASE + str(document) + '/'
        request_id = str(uuid4())
        first = self.generate(url, request_id=request_id)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.data['status'], 'queued')
        self.assertEqual(self.generate(url, request_id=request_id).data['id'], first.data['id'])
        self.assertEqual(self.generate(url, request_id=request_id, mode='course').status_code, 409)
        self.assertEqual(self.generate(url).status_code, 409)
        self.assertEqual(self.generate(url, source_start=False).status_code, 400)
        self.assertEqual(self.client.delete(url).status_code, 409)
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get(BASE + 'packs/').data, [])
        self.assertEqual(self.client.get(BASE + f"packs/{first.data['id']}/").status_code, 404)

    def test_lesson_documents_are_private(self):
        from courses.models import Course, Lesson
        from .models import Document

        course = Course.objects.create(title='Course', is_published=True)
        lesson = Lesson.objects.create(course=course, title='Lesson', content='Example')
        item = self.upload().data
        Document.objects.filter(pk=item['id']).update(lesson=lesson)
        url = f'/api/v1/courses/{course.pk}/lessons/{lesson.pk}/documents/'
        own = self.client.get(url)
        self.assertEqual(own.status_code, 200)
        self.assertEqual(own.data[0]['id'], item['id'])
        self.assertNotIn('file', own.data[0])
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get(url).data, [])

    def test_queue_limit_is_global_but_replay_bypasses_it(self):
        from unittest.mock import patch

        first_url = BASE + str(self.upload().data['id']) + '/'
        request_id = str(uuid4())
        first = self.generate(first_url, request_id=request_id)
        self.client.force_authenticate(self.other)
        other_url = BASE + str(self.upload().data['id']) + '/'
        with patch('documents.study_views.QUEUE_CAPACITY', 1):
            self.assertEqual(self.generate(other_url).status_code, 429)
            self.client.force_authenticate(self.user)
            self.assertEqual(self.generate(first_url, request_id=request_id).data['id'], first.data['id'])