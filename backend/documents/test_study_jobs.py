from copy import deepcopy
from datetime import timedelta
from io import StringIO
from unittest.mock import patch
from uuid import uuid4

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from .models import StudyPack
from .study_schema import InvalidStudyResult, check_result, strict_json
from .test_study import BASE, QUOTE, SOURCE, StudyApiFixture


def result():
    return {
        'title': '<script> plain text',
        'lessons': [],
        'questions': [
            dict(prompt=f'Question {number}', options=['One', 'Two', 'Three', 'Four'],
                 correct_index=1, hint='Think carefully', explanation='The document explains it.',
                 source_quote=QUOTE)
            for number in range(1, 4)
        ],
    }


def packet(status='ready', payload=None, error=None):
    return {'status': status, 'result': result() if status == 'ready' and payload is None else payload,
            'error_code': error}


class JobTests(StudyApiFixture, TestCase):
    def test_explicit_count_validates_ready_and_recovered_results(self):
        from .study_jobs import apply_reply

        pack = StudyPack.objects.get(pk=self.pack['id'])
        pack.generation_options = {'question_count': 7, 'detail': 'concise'}
        pack.save(update_fields=['generation_options'])
        for recovery in (False, True):
            with self.assertRaises(InvalidStudyResult):
                apply_reply(pack, packet(), recovery)
        payload = result()
        payload['questions'] = [dict(payload['questions'][0], prompt=f'Question {i}') for i in range(7)]
        apply_reply(pack, packet(payload=payload), True)
        pack.refresh_from_db()
        self.assertEqual(pack.status, 'ready')
        self.assertEqual(len(pack.result['questions']), 7)

    def setUp(self):
        super().setUp()
        self.document_url = BASE + str(self.upload().data['id']) + '/'
        self.pack = self.generate(self.document_url).data
        self.url = BASE + f"packs/{self.pack['id']}/"

    def run_once(self, response):
        with patch('documents.study_jobs.call_study', side_effect=response) as worker:
            call_command('run_study_jobs', once=True, stdout=StringIO())
        return worker

    def test_worker_and_key_privacy_and_latest_progress(self):
        worker = self.run_once(lambda *_args: packet())
        self.assertEqual(worker.call_args.args[0], '/study')
        self.assertEqual(worker.call_args.args[1]['source_text'], SOURCE[2:])
        self.assertEqual(worker.call_args.args[2], {'actor_id': str(self.user.pk)})
        pack = self.client.get(self.url).data
        self.assertEqual(pack['status'], 'ready')
        self.assertEqual(pack['title'], '<script> plain text')
        self.assertEqual(pack['source_excerpt'], SOURCE[2:])
        self.assertEqual(set(pack['questions'][0]), {'id', 'prompt', 'options'})
        self.assertEqual(self.client.post(self.url + 'hints/', {'question_id': 'q1'}, format='json').data,
                         {'hint': 'Think carefully'})

        def answer(choice, request_id=None, question_id='q1'):
            return self.client.post(self.url + 'attempts/',
                                    dict(request_id=request_id or str(uuid4()), question_id=question_id,
                                         choice=choice), format='json')

        request_id = str(uuid4())
        first = answer(1, request_id)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(first.data['score'], 1)
        self.assertEqual(first.data['source_quote'], QUOTE)
        self.assertEqual(answer(0, request_id).status_code, 409)
        self.assertEqual(answer(0).data['progress']['score'], 0)
        self.assertEqual(answer(1, request_id).data, first.data)
        self.assertEqual(self.client.get(self.url).data['progress']['score'], 0)
        self.assertEqual(answer(True).status_code, 400)
        self.assertEqual(answer(1, question_id='q2').data['progress']['answered'], 2)
        final = answer(1, question_id='q3').data['progress']
        self.assertEqual(final, dict(answered=3, total=3, score=2, max_score=3, percent=66.67, completed=True))
        self.client.force_authenticate(self.other)
        self.assertEqual(answer(1).status_code, 404)
        self.assertEqual(self.client.post(self.url + 'hints/', {'question_id': 'q1'}, format='json').status_code, 404)

    def test_restarts_recover_receipt_only(self):
        StudyPack.objects.filter(pk=self.pack['id']).update(
            status='running', dispatched_at=timezone.now() - timedelta(seconds=15))
        worker = self.run_once(lambda *_args: packet('pending'))
        self.assertEqual(worker.call_args.args[0], '/study/receipt')
        self.assertEqual(self.client.get(self.url).data['status'], 'running')
        self.assertEqual(self.client.delete(self.document_url).status_code, 409)
        worker = self.run_once(lambda *_args: packet())
        self.assertEqual(worker.call_args.args[0], '/study/receipt')
        self.assertEqual(self.client.get(self.url).data['status'], 'ready')

    def test_uncertain_http_later_recovers_without_repeat_generation(self):
        worker = self.run_once(TimeoutError('private text'))
        self.assertEqual(worker.call_args.args[0], '/study')
        self.assertEqual(self.client.get(self.url).data['status'], 'unknown')
        StudyPack.objects.filter(pk=self.pack['id']).update(receipt_due_at=timezone.now())
        worker = self.run_once(lambda *_args: packet())
        self.assertEqual(worker.call_args.args[0], '/study/receipt')
        self.assertEqual(self.client.get(self.url).data['status'], 'ready')

    def test_invalid_model_schema_fails_closed(self):
        value = result()
        value['questions'][0]['correct_index'] = True
        self.run_once(lambda *_args: packet(payload=value))
        pack = self.client.get(self.url).data
        self.assertEqual(pack['status'], 'failed')
        self.assertEqual(pack['error_code'], 'invalid_result')
        self.assertEqual(pack['questions'], [])
        self.assertFalse(StudyPack.objects.get(pk=self.pack['id']).result)

    def test_strict_output_schema(self):
        check_result(result(), 'test', SOURCE)
        for raw in (b'{"status":1,"status":2}', b'{"result":NaN}', b'{"result":'):
            with self.assertRaises(ValueError):
                strict_json(raw)
        for change in ({'source_quote': 'An invented citation of sufficient length.'},
                       {'options': ['one', ' One ', 'three', 'four']},
                       {'correct_index': float('nan')},
                       {'other': 'additional'}):
            value = deepcopy(result())
            value['questions'][0].update(change)
            with self.assertRaises(InvalidStudyResult):
                check_result(value, 'test', SOURCE)

    def test_dispatch_commits_claim_before_call_and_locks_other_dispatcher(self):
        from .study_jobs import worker_lock

        def check_dispatch(*args):
            record = StudyPack.objects.get(pk=self.pack['id'])
            self.assertEqual(record.status, 'running')
            self.assertIsNotNone(record.dispatched_at)
            with worker_lock() as acquired:
                self.assertFalse(acquired)
            return packet('missing')

        self.run_once(check_dispatch).assert_called_once()
        self.assertEqual(self.client.get(self.url).data['error_code'], 'invalid_result')
