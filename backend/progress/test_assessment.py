import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from django.test import TestCase, override_settings
from django.conf import settings
from django.db import connection
from rest_framework.test import APIClient
from accounts.models import User
from courses.models import Course, Lesson, Exercise
from tutor.context import content_digest, resolve_context
from .models import ExerciseAttempt, LessonProgress

@override_settings(LAT_AI_AUTOGRADE=True)
class AssessmentTests(TestCase):
    def setUp(self):
        self.user=User.objects.create_user('grade@example.test','Test-only-12345')
        self.course=Course.objects.create(title='Python',is_published=True)
        self.lesson=Lesson.objects.create(course=self.course,title='Types',content='Strings')
        self.exercise=Exercise.objects.create(lesson=self.lesson,title='Types',description='print("3" + "2")',is_published=True,max_score=60)
        self.client=APIClient();self.client.force_authenticate(self.user)
        self.tmp=tempfile.TemporaryDirectory(dir=settings.LAT_AI_RUNTIME);self.addCleanup(self.tmp.cleanup)
        self.mapping=Path(self.tmp.name)/'mapping.json'
        self.mapping.write_text(json.dumps({'version':'test','contexts':{f'{self.course.id}:{self.lesson.id}:{self.exercise.id}':{'task_key':'L1.types.1','lesson_key':'L1','digest':content_digest(self.course,self.lesson,self.exercise)}}}))
        self.override=override_settings(LAT_AI_MAPPING=self.mapping);self.override.enable();self.addCleanup(self.override.disable)

    def submit(self,answer='Строки соединяются, вывод 32.'):
        return self.client.post('/api/v1/progress/attempts/',{'exercise':self.exercise.id,'answer':answer,'score':999,'status':'checked'},format='json')

    @staticmethod
    def success(body,resolved):
        return 200,dict(contract_version='1.0',request_id=body['request_id'],outcome='assessed',checks=[True,False,True],evidence=[body['answer'],'',body['answer']],rubric_version='local-assessment-v1')

    def test_auto_score_progress_and_trusted_hint_event(self):
        with patch('progress.assessment.call_assessment',side_effect=self.success):r=self.submit()
        self.assertEqual(r.status_code,201);self.assertEqual(r.data['status'],'auto_checked');self.assertEqual(r.data['score'],40)
        attempt=ExerciseAttempt.objects.get();self.assertEqual(attempt.assessment['source'],'local_model')
        progress=LessonProgress.objects.get();self.assertTrue(progress.completed);self.assertEqual(round(progress.score,2),66.67)
        resolved=resolve_context(dict(course_id=self.course.id,lesson_id=self.lesson.id,exercise_id=self.exercise.id,action='hint'),self.user)
        self.assertEqual(resolved['hint_events'],[dict(id=f'attempt:{attempt.pk}',task_id='L1.types.1',kind='attempt',status='verified',passed=False)])
        self.assertTrue(r.data['feedback'].startswith('Автоматическая оценка ИИ. '))

    def test_failure_retains_answer_without_grade_and_resets_latest_progress(self):
        LessonProgress.objects.create(user=self.user,lesson=self.lesson,completed=True,score=100)
        with patch('progress.assessment.call_assessment',side_effect=TimeoutError('private exception')):r=self.submit()
        self.assertEqual(r.status_code,201);self.assertEqual(r.data['status'],'assessment_failed');self.assertIsNone(r.data['score'])
        self.assertNotIn('private exception',r.data['feedback']);self.assertFalse(LessonProgress.objects.get().completed)

    def test_changed_mapping_prevents_model_call(self):
        self.exercise.description='Different task';self.exercise.save()
        with patch('progress.assessment.call_assessment') as worker:r=self.submit()
        worker.assert_not_called();self.assertEqual(r.data['status'],'assessment_failed')

    def test_changes_during_generation_reject_stale_grade(self):
        def changed(body,resolved):
            Exercise.objects.filter(pk=self.exercise.pk).update(description='Changed while waiting')
            return self.success(body,resolved)
        with patch('progress.assessment.call_assessment',side_effect=changed):r=self.submit()
        self.assertEqual(r.data['status'],'assessment_failed');self.assertIsNone(r.data['score'])

    def test_malformed_reply_never_scores(self):
        for change in ({'checks':[True,1,True]},{'checks':[True,True]},{'request_id':'wrong'},{'rubric_version':'wrong'},{'outcome':'fallback'}):
            def bad(body,resolved):
                status,result=self.success(body,resolved);return status,{**result,**change}
            with patch('progress.assessment.call_assessment',side_effect=bad):r=self.submit()
            self.assertIsNone(r.data['score']);self.assertEqual(r.data['status'],'assessment_failed')

    def test_auth_and_length_boundaries(self):
        with patch('progress.assessment.call_assessment') as worker:
            self.assertEqual(self.submit('x'*4001).status_code,400)
            self.client.force_authenticate(None);self.assertEqual(self.submit().status_code,401)
            worker.assert_not_called()

    def test_human_review_wins_over_late_ai(self):
        def reviewed(body,resolved):
            ExerciseAttempt.objects.filter(pk=resolved['attempt_id']).update(status='checked',score=60,feedback='Human decision')
            return self.success(body,resolved)
        with patch('progress.assessment.call_assessment',side_effect=reviewed):r=self.submit()
        self.assertEqual(r.data['status'],'checked');self.assertEqual(r.data['score'],60)

    def test_initial_progress_reads_follow_writer_in_same_transaction(self):
        baseline=len(connection.savepoint_ids)
        seen=[]
        def inspect(execute,sql,params,many,context):
            if sql.startswith('UPDATE "progress_exerciseattempt" SET "assessment"'):
                seen.append(len(connection.savepoint_ids)>baseline)
            return execute(sql,params,many,context)
        with connection.execute_wrapper(inspect),patch('progress.assessment.call_assessment',side_effect=self.success):
            self.submit()
        self.assertEqual(seen,[True], 'Initial writer must be inside the transaction before progress SELECTs')

    @override_settings(LAT_AI_AUTOGRADE=False)
    def test_production_default_unchanged(self):
        with patch('progress.assessment.call_assessment') as worker:r=self.submit()
        worker.assert_not_called();self.assertEqual(r.data['status'],'submitted')
