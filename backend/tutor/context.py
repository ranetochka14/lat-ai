import hashlib
import json
import math
from pathlib import Path
from django.conf import settings
from django.http import Http404
from courses.models import Course, Lesson, Exercise
from progress.models import ExerciseAttempt
from progress.assessment import automatic_hint_result

def content_digest(course, lesson, exercise=None):
    values = [course.id, course.title, course.subject, lesson.id, lesson.title, lesson.content]
    if exercise:
        values += [exercise.id, exercise.title, exercise.description, exercise.task_type, float(exercise.max_score)]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',',':')).encode('utf-8')).hexdigest()

def resources(body):
    try:
        lesson = Lesson.objects.select_related('course').get(pk=body['lesson_id'], course_id=body['course_id'], course__is_published=True)
        exercise = None
        if body.get('exercise_id') is not None:
            exercise = Exercise.objects.get(pk=body['exercise_id'], lesson=lesson, is_published=True)
        return lesson.course, lesson, exercise
    except (Lesson.DoesNotExist, Exercise.DoesNotExist):
        raise Http404

def mapping_for(course, lesson, exercise):
    try:
        path = Path(getattr(settings,'LAT_AI_MAPPING', ''))
        if not path.is_file() or path.stat().st_size > 1000000:
            return None
        document = json.loads(path.read_text(encoding='utf-8'))
        record = document['contexts'][f'{course.id}:{lesson.id}:{exercise.id if exercise else 0}']
        if record['digest'] != content_digest(course,lesson,exercise):
            return None
        return {**record, 'mapping_version':document['version'] + ':' + record['digest'][:32]}
    except (OSError, ValueError, KeyError, TypeError):
        return None

def resolve_context(body, actor):
    course,lesson,exercise = resources(body)
    mapping = mapping_for(course,lesson,exercise) or {}
    r = dict(actor_id=actor.id,access='granted',course_id=course.id,lesson_id=lesson.id,exercise_id=exercise.id if exercise else None,
             lesson_key=mapping.get('lesson_key'),topic=mapping.get('topic'),task_key=mapping.get('task_key'),mapping_version=mapping.get('mapping_version'),hint_events=[])
    if body['action'] == 'hint' and exercise and r['task_key']:
        # "Verified" is a trusted hint event, independent of human review.
        # Keep the provenance checks for automatic and manually reviewed grades separate.
        attempts = ExerciseAttempt.objects.filter(
            user=actor, exercise=exercise, status__in=('checked', 'auto_checked'), score__isnull=False,
        ).order_by('id')[:1001]
        for attempt in attempts:
            if attempt.status == 'auto_checked':
                passed = automatic_hint_result(attempt, r['task_key'], mapping['digest'], exercise.max_score)
            elif math.isfinite(attempt.score) and 0 <= attempt.score <= exercise.max_score:
                passed = attempt.score == exercise.max_score
            else:
                passed = None
            if passed is not None:
                r['hint_events'].append(dict(
                    id=f'attempt:{attempt.id}', task_id=r['task_key'], kind='attempt', status='verified', passed=passed,
                ))
    return r
