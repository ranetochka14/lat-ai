
from django.conf import settings
from django.db import models
from pgvector.django import VectorField


def user_document_path(instance, filename):
    return f"users/{instance.owner_id}/documents/{filename}"


class Document(models.Model):
    STATUS_CHOICES = [
        ("uploaded", "Загружен"),
        ("processing", "Обрабатывается"),
        ("ready", "Готов"),
        ("failed", "Ошибка"),
    ]

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="documents",
        verbose_name="Владелец"
    )

    lesson = models.ForeignKey(
        "courses.Lesson",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="documents",
        verbose_name="Урок"
    )

    title = models.CharField(
        "Название материала",
        max_length=255
    )

    file = models.FileField(
        "Файл",
        upload_to=user_document_path
    )

    mime_type = models.CharField(
        "Тип файла",
        max_length=120,
        blank=True
    )

    status = models.CharField(
        "Статус обработки",
        max_length=20,
        choices=STATUS_CHOICES,
        default="uploaded"
    )

    error = models.CharField(max_length=40, blank=True)

    extracted_text = models.TextField(
        "Извлечённый текст",
        blank=True
    )

    created_at = models.DateTimeField(
        "Дата загрузки",
        auto_now_add=True
    )

    class Meta:
        verbose_name = "Учебный материал"
        verbose_name_plural = "Учебные материалы"
        ordering = ["-created_at"]

    def __str__(self):
        return self.title


class DocumentChunk(models.Model):
    embedding = VectorField(
        dimensions=384,
        null=True,
        blank=True
    )

    document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="chunks",
        verbose_name="Документ"
    )

    content = models.TextField(
        "Содержимое фрагмента"
    )

    chunk_index = models.PositiveIntegerField(
        "Номер фрагмента"
    )

    created_at = models.DateTimeField(
        "Дата создания",
        auto_now_add=True
    )

    class Meta:
        ordering = ["chunk_index"]
        unique_together = ("document", "chunk_index")
        verbose_name = "Фрагмент документа"
        verbose_name_plural = "Фрагменты документов"

    def __str__(self):
        return f"{self.document.title} — фрагмент {self.chunk_index}"


ACTIVE_STUDY_STATUSES = ('queued', 'running')


class StudyQueueLock(models.Model):
    """A row locked by enqueue, delete and attempt transactions."""


class StudyPack(models.Model):
    class Status(models.TextChoices):
        QUEUED = 'queued'
        RUNNING = 'running'
        READY = 'ready'
        FAILED = 'failed'
        UNKNOWN = 'unknown'

    class Mode(models.TextChoices):
        COURSE = 'course'
        TEST = 'test'

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name='study_packs')
    request_id = models.UUIDField()
    mode = models.CharField(max_length=6, choices=Mode.choices)
    generation_options = models.JSONField(default=dict)
    source_start = models.PositiveIntegerField()
    source_end = models.PositiveIntegerField()
    source_text = models.TextField()
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.QUEUED)
    error_code = models.CharField(max_length=80, blank=True)
    result = models.JSONField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    dispatched_at = models.DateTimeField(null=True)
    receipt_due_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=('owner', 'request_id'), name='unique_study_generation'),
            models.UniqueConstraint(
                fields=('owner',), condition=models.Q(status__in=ACTIVE_STUDY_STATUSES),
                name='unique_active_study_owner',
            ),
        ]
        indexes = [models.Index(fields=('status', 'id'))]


class StudyAttempt(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    pack = models.ForeignKey(StudyPack, on_delete=models.CASCADE, related_name='attempts')
    request_id = models.UUIDField()
    question_id = models.CharField(max_length=2)
    choice = models.PositiveSmallIntegerField()
    correct = models.BooleanField()
    progress_snapshot = models.JSONField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=('owner', 'request_id'), name='unique_study_attempt'),
        ]
        indexes = [models.Index(fields=('pack', 'question_id', '-id'))]
