"""Authenticated pilot API. Public responses are built from explicit allowlists."""
from pathlib import PurePath
from uuid import UUID, uuid4

from django.db import transaction
from django.db.models.functions import Length
from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import APIException
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ACTIVE_STUDY_STATUSES, Document, StudyAttempt, StudyPack, StudyQueueLock
from .study_extraction import ExtractionError, MAX_UPLOAD, MIME_TYPES, extract_upload

QUEUE_CAPACITY = 8


class StudyApiError(APIException):
    def __init__(self, code, status=400):
        self.status_code = status
        super().__init__({'error': code})


def lock_queue():
    # An UPDATE acquires the write lock before any reads, including on SQLite.
    StudyQueueLock.objects.filter(pk=1).update(id=1)


def request_body(request, keys):
    body = request.data
    if type(body) is not dict or body.keys() != set(keys):
        raise StudyApiError('invalid_request')
    return body


def request_uuid(value):
    try:
        if type(value) is str and str(UUID(value)) == value.lower():
            return UUID(value)
    except ValueError:
        pass
    raise StudyApiError('invalid_request')


def owner_document(request, pk):
    return get_object_or_404(Document, owner=request.user, pk=pk)


def owner_packs(request):
    return StudyPack.objects.filter(owner=request.user, document__owner=request.user)


def document_data(document):
    length = getattr(document, "text_length", None)
    return {
        'id': document.pk,
        'title': document.title,
        'mime_type': document.mime_type,
        'status': document.status,
        'created_at': document.created_at,
        'error': document.error or None,
        'text_length': len(document.extracted_text) if length is None else length,
    }


def progress_for(pack, total):
    latest = {}
    if total:
        answers = pack.attempts.filter(owner_id=pack.owner_id).order_by('-id')
        for question_id, correct in answers.values_list('question_id', 'correct').iterator():
            latest.setdefault(question_id, correct)
            if len(latest) == total:
                break
    score = sum(latest.values())
    return {
        'answered': len(latest),
        'total': total,
        'score': score,
        'max_score': total,
        'percent': round(score / total * 100, 2) if total else 0,
        'completed': bool(total and len(latest) == total),
    }


def pack_data(pack, detail=True):
    result = pack.result if pack.status == StudyPack.Status.READY else None
    questions = result['questions'] if result else []
    data = {
        'id': pack.pk,
        'document_id': pack.document_id,
        'status': pack.status,
        'error_code': pack.error_code or None,
        'source_start': pack.source_start,
        'source_end': pack.source_end,
        'mode': pack.mode,
        'generation_options': pack.generation_options,
        'title': result['title'] if result else pack.document.title,
        'progress': progress_for(pack, len(questions)),
    }
    if detail:
        data['source_excerpt'] = pack.source_text
        data['lessons'] = result['lessons'] if result else []
        data['questions'] = [
            {'id': f'q{index}', 'prompt': question['prompt'], 'options': question['options']}
            for index, question in enumerate(questions, start=1)
        ]
    return data


def ready_question(pack, question_id):
    if pack.status != StudyPack.Status.READY or pack.result is None:
        raise StudyApiError('pack_not_ready', 409)
    for index, question in enumerate(pack.result['questions'], start=1):
        if question_id == f'q{index}':
            return question
    raise StudyApiError('unknown_question', 404)


class PrivateStudyView(APIView):
    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        return response


class DocumentListUpload(PrivateStudyView):
    def get(self, request):
        documents = Document.objects.filter(owner=request.user).defer('file', 'extracted_text').annotate(
            text_length=Length('extracted_text')
        )
        return Response([document_data(document) for document in documents])

    def post(self, request):
        # Reject excessive request bodies before Django buffers multipart files.
        length = str(request.META.get('CONTENT_LENGTH') or '')
        if length.isascii() and length.isdecimal() and (len(length) > 12 or int(length) > MAX_UPLOAD + 65536):
            raise StudyApiError('file_too_large', 413)
        if set(request.FILES) != {'file'} or len(request.FILES.getlist('file')) != 1:
            raise StudyApiError('invalid_request')
        upload = request.FILES['file']
        extension = PurePath(upload.name).suffix.lower()
        if extension not in MIME_TYPES:
            raise StudyApiError('unsupported_type')
        if upload.size > MAX_UPLOAD:
            raise StudyApiError('file_too_large', 413)
        document = Document(owner=request.user, title=upload.name, mime_type=MIME_TYPES[extension])
        try:
            document.extracted_text = extract_upload(upload)
        except ExtractionError as error:
            document.status = 'failed'
            document.error = str(error)
            document.save()
        else:
            document.status = 'ready'
            # Keep user-supplied filenames out of the storage path.
            document.file.save(f'{uuid4().hex}{extension}', upload, save=False)
            try:
                document.save()
            except Exception:
                document.file.delete(save=False)
                raise
        return Response(document_data(document), status=201)


class DocumentDetail(PrivateStudyView):
    def get(self, request, pk):
        document = owner_document(request, pk)
        return Response({**document_data(document), 'extracted_text': document.extracted_text})

    @transaction.atomic
    def delete(self, request, pk):
        lock_queue()
        document = owner_document(request, pk)
        if document.study_packs.filter(status__in=ACTIVE_STUDY_STATUSES).exists():
            raise StudyApiError('generation_active', 409)
        storage, name = document.file.storage, document.file.name
        document.delete()
        if name:
            transaction.on_commit(lambda: storage.delete(name), robust=True)
        return Response(status=204)


class DocumentDownload(PrivateStudyView):
    def get(self, request, pk):
        document = owner_document(request, pk)
        if not document.file:
            raise Http404
        try:
            file = document.file.open('rb')
        except FileNotFoundError:
            raise Http404 from None
        response = FileResponse(file, as_attachment=True, filename=document.title,
                                content_type='application/octet-stream')
        response['X-Content-Type-Options'] = 'nosniff'
        return response


class GenerateStudyPack(PrivateStudyView):
    @transaction.atomic
    def post(self, request, pk):
        keys = ('request_id', 'mode', 'source_start', 'source_end')
        if type(request.data) is dict and 'generation_options' in request.data:
            keys += ('generation_options',)
        body = request_body(request, keys)
        options = body.get('generation_options', {})
        if 'generation_options' in body and (
            type(options) is not dict or set(options) != {'question_count', 'detail'}
            or type(options['question_count']) is not int or options['question_count'] not in (5, 6, 7)
            or options['detail'] not in ('concise', 'detailed')
        ):
            raise StudyApiError('invalid_request')
        request_id = request_uuid(body['request_id'])
        mode, start, end = body['mode'], body['source_start'], body['source_end']
        if mode not in StudyPack.Mode.values or type(start) is not int or type(end) is not int:
            raise StudyApiError('invalid_request')
        lock_queue()
        document = owner_document(request, pk)
        prior = owner_packs(request).select_related('document').filter(request_id=request_id).first()
        if prior:
            if (prior.document_id, prior.mode, prior.source_start, prior.source_end, prior.generation_options) != (pk, mode, start, end, options):
                raise StudyApiError('request_conflict', 409)
            return Response(pack_data(prior), status=202)
        if document.status != 'ready':
            raise StudyApiError('document_not_ready', 409)
        if not (0 <= start < end <= len(document.extracted_text) and 100 <= end - start <= 6000):
            raise StudyApiError('invalid_range')
        excerpt = document.extracted_text[start:end]
        if not excerpt.strip():
            raise StudyApiError('invalid_range')
        active = StudyPack.objects.filter(status__in=ACTIVE_STUDY_STATUSES)
        if active.filter(owner=request.user).exists():
            raise StudyApiError('generation_active', 409)
        if active.count() >= QUEUE_CAPACITY:
            raise StudyApiError('queue_full', 429)
        pack = StudyPack.objects.create(
            owner=request.user, document=document, request_id=request_id, mode=mode,
            source_start=start, source_end=end, source_text=excerpt, generation_options=options,
        )
        return Response(pack_data(pack), status=202)


class StudyPackList(PrivateStudyView):
    def get(self, request):
        packs = owner_packs(request).select_related('document').defer(
            'document__extracted_text', 'document__file', 'source_text',
        ).order_by('-id')
        return Response([pack_data(pack, detail=False) for pack in packs])


class StudyPackDetail(PrivateStudyView):
    def get(self, request, pk):
        pack = get_object_or_404(owner_packs(request).select_related('document'), pk=pk)
        return Response(pack_data(pack))


class StudyHint(PrivateStudyView):
    def post(self, request, pk):
        pack = get_object_or_404(owner_packs(request), pk=pk)
        body = request_body(request, ('question_id',))
        question = ready_question(pack, body['question_id'])
        return Response({'hint': question['hint']})


class StudyAttemptSubmit(PrivateStudyView):
    @transaction.atomic
    def post(self, request, pk):
        body = request_body(request, ('request_id', 'question_id', 'choice'))
        request_id = request_uuid(body['request_id'])
        question_id, choice = body['question_id'], body['choice']
        if type(choice) is not int or not 0 <= choice <= 3:
            raise StudyApiError('invalid_request')
        lock_queue()
        pack = get_object_or_404(owner_packs(request), pk=pk)
        attempt = StudyAttempt.objects.filter(owner=request.user, request_id=request_id).first()
        if attempt and (attempt.pack_id, attempt.question_id, attempt.choice) != (pk, question_id, choice):
            raise StudyApiError('request_conflict', 409)
        question = ready_question(pack, question_id)
        if attempt is None:
            attempt = StudyAttempt.objects.create(
                owner=request.user, pack=pack, request_id=request_id, question_id=question_id,
                choice=choice, correct=choice == question['correct_index'], progress_snapshot={},
            )
            attempt.progress_snapshot = progress_for(pack, len(pack.result['questions']))
            attempt.save(update_fields=['progress_snapshot'])
        return Response({
            'id': attempt.pk,
            'question_id': question_id,
            'choice': choice,
            'correct': attempt.correct,
            'score': int(attempt.correct),
            'max_score': 1,
            'feedback': question['option_explanations'][choice] if 'option_explanations' in question else question['explanation'],
            'correct_option': question['options'][question['correct_index']],
            'source_quote': question['source_quote'],
            'progress': attempt.progress_snapshot,
        }, status=201)
