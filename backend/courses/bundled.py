"""Reviewed public lessons only. No answer keys, migrations or model requests."""
import hashlib
import json
from pathlib import Path

from django.db import transaction
from .models import Course, Lesson

BUNDLE_SHA256 = 'c64354e5641dcf7e434da3b25e7c18c84156fc5deb2332902488684106e003bb'


def load_catalog():
    raw = (Path(__file__).parent / 'data/school-courses-v3.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != BUNDLE_SHA256:
        raise ValueError('Bundled course checksum mismatch')
    return json.loads(raw)['courses']


def install_catalog(catalog=None):
    """Atomic insert, or exact-match no-op. A title collision never overwrites data."""
    catalog = load_catalog() if catalog is None else catalog
    result = []
    with transaction.atomic():
        for item in catalog:
            matches = list(Course.objects.filter(title=item['title']))
            if matches:
                course = matches[0]
                actual = list(course.lessons.order_by('order', 'id').values('title', 'content', 'order'))
                if (len(matches) != 1 or not course.is_published
                        or course.description != item['description'] or course.subject != item['subject']
                        or actual != item['lessons']):
                    raise ValueError('Course title collision; existing content was preserved: ' + item['title'])
                state = 'already_installed'
            else:
                course = Course.objects.create(title=item['title'], description=item['description'],
                                               subject=item['subject'], is_published=True)
                Lesson.objects.bulk_create([Lesson(course=course, **lesson) for lesson in item['lessons']])
                state = 'installed'
            result.append({'id': course.id, 'title': course.title, 'lessons': len(item['lessons']), 'status': state})
    return result
