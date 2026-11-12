"""Independent validation for all study results received over IPC."""
import json
import re
from unicodedata import normalize


class InvalidStudyResult(ValueError):
    pass


def strict_json(raw):
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise InvalidStudyResult('duplicate JSON member')
            result[key] = value
        return result

    def invalid_constant(_value):
        raise InvalidStudyResult('invalid JSON constant')

    return json.loads(raw, object_pairs_hook=unique_keys, parse_constant=invalid_constant)


def exact_keys(value, keys):
    if type(value) is not dict or value.keys() != set(keys):
        raise InvalidStudyResult('invalid object')


def check_string(value, maximum, minimum=1):
    if (
        type(value) is not str
        or not minimum <= len(value) <= maximum
        or not value.strip()
        or '\x00' in value
        or re.search(r'[\ud800-\udfff]', value)
    ):
        raise InvalidStudyResult('invalid text')


def check_quote(value, source):
    check_string(value, 500, minimum=20)
    if value not in source:
        raise InvalidStudyResult('invalid source quote')


def normalized(text):
    return normalize('NFKC', text.strip()).lower()


def check_result(result, mode, source):
    exact_keys(result, ('title', 'lessons', 'questions'))
    check_string(result['title'], 160)
    lessons = result['lessons']
    if type(lessons) is not list or not (
        (mode == 'test' and not lessons) or (mode == 'course' and 1 <= len(lessons) <= 3)
    ):
        raise InvalidStudyResult('invalid lessons')
    for lesson in lessons:
        exact_keys(lesson, ('title', 'content', 'source_quote'))
        check_string(lesson['title'], 160)
        check_string(lesson['content'], 1800)
        check_quote(lesson['source_quote'], source)

    questions = result['questions']
    if type(questions) is not list or not 3 <= len(questions) <= 7:
        raise InvalidStudyResult('invalid questions')
    prompts = set()
    for question in questions:
        keys = ('prompt', 'options', 'correct_index', 'hint', 'explanation', 'source_quote')
        if type(question) is dict and 'option_explanations' in question:
            keys += ('option_explanations',)
        exact_keys(question, keys)
        check_string(question['prompt'], 500)
        prompt = normalized(question['prompt'])
        if prompt in prompts:
            raise InvalidStudyResult('duplicate question')
        prompts.add(prompt)
        options = question['options']
        if type(options) is not list or len(options) != 4:
            raise InvalidStudyResult('invalid options')
        for option in options:
            check_string(option, 250)
        if len({normalized(option) for option in options}) != 4:
            raise InvalidStudyResult('duplicate option')
        index = question['correct_index']
        if type(index) is not int or not 0 <= index <= 3:
            raise InvalidStudyResult('invalid key')
        check_string(question['hint'], 400)
        check_string(question['explanation'], 600)
        if 'option_explanations' in question:
            explanations = question['option_explanations']
            if type(explanations) is not list or len(explanations) != 4:
                raise InvalidStudyResult('invalid option explanations')
            for explanation in explanations:
                check_string(explanation, 500)
        check_quote(question['source_quote'], source)
    return result
