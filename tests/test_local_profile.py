import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pilot_profile', Path(__file__).resolve().parents[1] / 'tools/pilot.py')
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class LocalProfileTests(unittest.TestCase):
    def configure(self, directory, profile=None):
        if profile is not None:
            (Path(directory) / 'ai-local.json').write_text(json.dumps(profile), encoding='utf-8')
        pilot.configure(argparse.Namespace(runtime=directory, python_extra_site=None, worker_port=8388,
                                           site_port=5188, api_port=8008))

    def test_defaults_and_opt_in_do_not_change_other_runtimes(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b, patch.dict(os.environ):
            self.configure(a, {'model_budget_ms': 60000, 'study_budget_ms': 900000})
            self.assertEqual(os.environ['LAT_AI_MODEL_BUDGET_MS'], '60000')
            self.assertEqual(os.environ['LAT_AI_STUDY_BUDGET_MS'], '900000')
            self.configure(b)
            self.assertEqual(os.environ['LAT_AI_MODEL_BUDGET_MS'], '7900')
            self.assertEqual(os.environ['LAT_AI_STUDY_BUDGET_MS'], '180000')

    def test_invalid_or_unrelated_options_fail_closed(self):
        for profile in ({'model_budget_ms': True}, {'model_budget_ms': 60001},
                        {'model_budget_ms': '60000'}, {'model_budget_ms': 60000, 'study_budget_ms': 900001},
                        {'model_budget_ms': 60000, 'secret': 'not accepted'}, []):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
                with self.assertRaises(RuntimeError):
                    self.configure(directory, profile)


if __name__ == '__main__':
    unittest.main()
