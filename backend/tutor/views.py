from django.conf import settings
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import permissions, status
from .serializers import TutorAskSerializer
from .context import resolve_context, resources, mapping_for
from .transport import call_worker, worker_status
from django.core.exceptions import RequestDataTooBig
from django.http import Http404
from rest_framework.exceptions import APIException, ParseError

def error_body(code, message, request_id=None):
    return {'contract_version':'1.0','request_id':request_id,'error':{'code':code,'message':message,'retryable':False}}

class ContractView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def handle_exception(self, exc):
        if isinstance(exc,RequestDataTooBig):
            return Response(error_body('PAYLOAD_TOO_LARGE','Запрос слишком большой. Текст не обрезан.'),status=413)
        if isinstance(exc,Http404):
            return Response(error_body('CONTEXT_NOT_AVAILABLE','Этот учебный контекст недоступен.'),status=404)
        if isinstance(exc,APIException):
            code='AUTH_REQUIRED' if exc.status_code in (401,403) else 'INVALID_REQUEST'
            if hasattr(exc,'get_codes') and 'INVALID_CODE_CONTEXT' in str(exc.get_codes()):
                code='INVALID_CODE_CONTEXT'
            return Response(error_body(code,'Войди в платформу.' if code=='AUTH_REQUIRED' else 'Проверь поля запроса.'),status=exc.status_code)
        return Response(error_body('AI_UNAVAILABLE','Помощник сейчас недоступен.'),status=503)

class TutorAskView(ContractView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        # Read the actual body under a bound; Content-Length alone is not trusted.
        if len(request.body)>49152:
            raise RequestDataTooBig
        serializer = TutorAskSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        body=serializer.validated_data
        resolved=resolve_context(body,request.user)
        code,response=call_worker(body,resolved)
        return Response(response,status=code,headers={'Cache-Control':'no-store'})


class TutorStatusView(ContractView):
    def get(self, request):
        try:
            result = worker_status()
        except (OSError, ValueError, KeyError, TypeError, RuntimeError):
            result = {'state': 'unavailable', 'can_generate': False}
        return Response(result, headers={'Cache-Control': 'no-store'})

class TutorContextView(ContractView):
    def get(self,request):
        try:
            course_id=int(request.query_params['course_id']);lesson_id=int(request.query_params['lesson_id'])
            if min(course_id,lesson_id)<1: raise ValueError
        except (KeyError,ValueError):
            raise ParseError
        course,lesson,_=resources({'course_id':course_id,'lesson_id':lesson_id})
        exercises=[]
        for exercise in lesson.exercises.filter(is_published=True):
            mapping=mapping_for(course,lesson,exercise)
            exercises.append({'exercise_id':exercise.id,'supported':bool(mapping),'hint_supported':bool(mapping and mapping.get('task_key')),
                              'initial_code':mapping.get('initial_code','') if mapping else ''})
        return Response({'contract_version':'1.0','course_id':course_id,'lesson_id':lesson_id,'exercises':exercises,'timeout_ms':getattr(settings, 'LAT_AI_CLIENT_TIMEOUT_MS', 10000)},headers={'Cache-Control':'no-store'})
