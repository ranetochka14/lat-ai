"""Prepare ONLY the isolated AI-review profile; never the production database."""
import json
import os
import secrets
import sys
from pathlib import Path

project=Path(__file__).resolve().parent.parent
runtime=Path(os.environ.get('LAD_AI_RUNTIME', project/'.runtime'/'i02')).resolve()
runtime.mkdir(parents=True,exist_ok=True)
for name in ('ipc-secret.txt','django-secret.txt'):
    path=runtime/name
    if not path.exists():
        path.write_text(secrets.token_hex(32),encoding='utf-8')
os.environ['DJANGO_SETTINGS_MODULE']='config.ai_local'
os.environ['LAD_AI_RUNTIME']=str(runtime)
os.environ.pop('LAD_AI_TEST',None)
sys.path.insert(0,str(project/'backend'))
import django
django.setup()
from django.conf import settings
from django.core.management import call_command
from django.db import transaction
from accounts.models import User
from courses.models import Course,Lesson,Exercise
from tutor.context import content_digest

assert Path(settings.DATABASES['default']['NAME']).resolve()==runtime/'django.sqlite3'
call_command('migrate',interactive=False,verbosity=0)
marker=runtime/'seed.json'
if marker.exists():
    print('Existing isolated AI data retained. No course/account overwrites.')
    sys.exit(0)

materials=json.loads((project/'integration/ai/core/data/materials.json').read_text(encoding='utf-8'))['documents']
catalog=[
 ('L1','Строки, числа и условия',[
  ('L1.types.1','types','Почему строки соединяются?','Объясни, как работает знак + в этом примере. Сначала определи типы значений.','print("3" + "2")'),
  ('L1.condition.1','условия','Выбор ветки','Проследи проверку условия. Какая ветка будет выбрана и почему?','x = 2\nif x == 2:\n    print("да")\nelse:\n    print("нет")')]),
 ('L2','Циклы и накопитель',[
  ('L2.range.1','range','Границы range','Объясни, какие значения задаёт range и почему конечная граница не входит.','for i in range(2, 5):\n    print(i)'),
  ('L2.accumulator.1','накопитель','Сохраняем сумму','Проследи, где создаётся s и как она меняется. Объясни роль отступа последней строки.','s = 0\nfor i in range(1, 4):\n    s = s + i\nprint(s)')])]
contexts={};ids=[]
with transaction.atomic():
    User.objects.create_user('review@lad-ai.local','LadAI-Review-2026!',display_name='Взрослый оценщик')
    course=Course.objects.create(title='Python · автопроверка LAT AI',subject='Программирование',is_published=True,description='Примеры L1/L2 с автоматическими подсказками, оценкой и прогрессом. Пилот: ИИ может ошибаться.')
    for order,(key,title,tasks) in enumerate(catalog,1):
        lesson=Lesson.objects.create(course=course,title=title,content=materials[key],order=order)
        contexts[f'{course.id}:{lesson.id}:0']={'lesson_key':key,'topic':tasks[0][1],'task_key':None,'digest':content_digest(course,lesson)}
        for task,topic,title,description,code in tasks:
            exercise=Exercise.objects.create(lesson=lesson,title=title,description=description+'\n\n'+code,task_type='code')
            contexts[f'{course.id}:{lesson.id}:{exercise.id}']={'lesson_key':key,'topic':topic,'task_key':task,'initial_code':code,'digest':content_digest(course,lesson,exercise)}
            ids.append({'course_id':course.id,'lesson_id':lesson.id,'exercise_id':exercise.id,'task_key':task})
(runtime/'mapping.json').write_text(json.dumps({'version':'i02-local-v1','contexts':contexts},ensure_ascii=False,indent=2),encoding='utf-8')
marker.write_text(json.dumps({'profile':'isolated-ai-review','contexts':ids},ensure_ascii=False,indent=2),encoding='utf-8')
print('Prepared 2 lessons / 4 exercises; no verified attempts or grades fabricated.')
