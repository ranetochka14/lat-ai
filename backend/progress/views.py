
from django.db import transaction
from django.conf import settings
from rest_framework import generics, permissions
from rest_framework.views import APIView
from rest_framework.response import Response

from courses.models import Course, Exercise
from .models import LessonProgress, ExerciseAttempt
from .serializers import (
    LessonProgressSerializer,
    ExerciseAttemptSerializer,
    ExerciseAttemptReviewSerializer,
)


def update_lesson_progress(user, lesson):
    """
    Пересчитывает прогресс ученика после проверки задания.
    Учитываются опубликованные задания и последние попытки.
    """

    exercises = Exercise.objects.filter(
        lesson=lesson,
        is_published=True
    )

    if not exercises.exists():
        return

    total_score = 0
    all_checked = True

    for exercise in exercises:
        attempt = ExerciseAttempt.objects.filter(
            user=user,
            exercise=exercise
        ).order_by("-submitted_at", "-id").first()

        if attempt is None or attempt.status not in ("checked", "auto_checked") or attempt.score is None:
            all_checked = False
            break

        max_score = exercise.max_score

        if max_score > 0:
            total_score += (attempt.score or 0) / max_score * 100

    if all_checked:
        average_score = total_score / exercises.count()
    else:
        average_score = None

    LessonProgress.objects.update_or_create(
        user=user,
        lesson=lesson,
        defaults={
            "completed": all_checked,
            "score": average_score,
        }
    )



class ProgressListView(generics.ListAPIView):
    serializer_class = LessonProgressSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return LessonProgress.objects.filter(
            user=self.request.user
        ).select_related("lesson")


class StudentDashboardView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        courses = Course.objects.filter(is_published=True)

        result = []

        for course in courses:
            total_lessons = course.lessons.count()

            progress = LessonProgress.objects.filter(
                user=request.user,
                lesson__course=course
            )

            completed = progress.filter(
                completed=True
            ).count()

            scores = list(
                progress.filter(
                    completed=True,
                    score__isnull=False
                ).values_list("score", flat=True)
            )

            average_score = (
                sum(scores) / len(scores)
                if scores else 0
            )

            percent = (
                completed / total_lessons * 100
                if total_lessons else 0
            )

            result.append({
                "course_id": course.id,
                "course_title": course.title,
                "total_lessons": total_lessons,
                "completed_lessons": completed,
                "completion_percent": round(percent, 2),
                "average_score": round(average_score, 2),
            })

        return Response({
            "student": request.user.email,
            "courses": result,
            "total_courses": len(result),
        })


class ExerciseAttemptListCreateView(generics.ListCreateAPIView):
    serializer_class = ExerciseAttemptSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return ExerciseAttempt.objects.filter(
            user=self.request.user
        ).select_related("exercise")

    def perform_create(self, serializer):
        attempt = serializer.save(user=self.request.user)
        if getattr(settings, 'LAT_AI_AUTOGRADE', False):
            from .assessment import assess_attempt
            assess_attempt(attempt, update_lesson_progress)


class ExerciseAttemptReviewView(generics.UpdateAPIView):
    serializer_class = ExerciseAttemptReviewSerializer
    permission_classes = [permissions.IsAdminUser]

    queryset = ExerciseAttempt.objects.select_related(
        "exercise",
        "exercise__lesson"
    )

    @transaction.atomic
    def perform_update(self, serializer):
        attempt = serializer.save(status="checked")

        update_lesson_progress(
            user=attempt.user,
            lesson=attempt.exercise.lesson
        )
