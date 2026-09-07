"""Native AFT storage and asynchronous service contracts."""

import tempfile
import threading
import unittest
from unittest.mock import Mock

from backend.aft_store import AftStore
from backend.native_analysis import (
    PIPELINE_VERSION, RUN_ANALYSIS_TARGET_SECONDS, RUN_PIPELINE_VERSION,
    TASK_ANALYSIS_TARGET_SECONDS,
    ExecutionAnalysisService, _agentic_tools,
    _canonical_turn_id, _retryable_codex_error, _validate_task_synthesis,
)
from backend.codex import CodexError
from backend.services import InvalidQuery, ResourceNotFound


class Reader:
    def __init__(self, status='succeeded'):
        self.status = status

    def batch(self, run):
        return {'batch_id': run, 'tasks': [{'key': '0001-003', 'status': self.status}]}


class Codex:
    def models(self):
        return {'models': [{
            'id': 'gpt-a', 'model': 'gpt-a', 'displayName': 'GPT A',
            'description': 'test', 'isDefault': True,
        }]}


class ExecutionAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        catalog = Mock()
        catalog.reader = Reader()
        self.store = AftStore(self.directory.name + '/aft.sqlite3')
        self.service = ExecutionAnalysisService(catalog, Mock(), self.store, Codex(), workers=1)

    def tearDown(self):
        self.service.close()
        self.directory.cleanup()

    def test_taxonomy_is_versioned_and_persisted(self):
        value = self.service.taxonomy()
        self.assertEqual(value['version']['version_id'], 'lhht/2026-09-07.1')
        self.assertEqual(len(value['tags']), 8)
        tag = next(item for item in value['tags']
                   if item['tag_id'] == 'LHHT-PROG-003')
        self.assertEqual(tag['name_en'], 'Producer-coupled progress acceptance')
        self.assertIn('执行工作的一方', tag['description'])
        self.assertEqual(tag['fault_side'],
                         'harness; mapping requires task evidence')
        self.assertTrue(tag['sources'])
        supporting = {source['source_id'] for source in tag['sources']
                      if source['support_kind'] == 'supporting'}
        self.assertEqual(len(supporting), 3)
        self.assertIn('longhorizon-harness', supporting)
        self.assertIn('structagent', supporting)
        self.assertIn('anthropic-long-running', supporting)
        self.assertEqual({source['source_type'] for source in tag['sources']},
                         {'paper', 'authoritative-organization'})
        harnessrisk = next(item for item in value['research_foundation']
                           if item['source_id'] == 'harnessrisk')
        self.assertIn('does not support general capability',
                      harnessrisk['support_note'])
        security = next(item for item in value['tags']
                        if item['tag_id'] == 'LHHT-SEC-007')
        governance = next(item for item in value['tags']
                          if item['tag_id'] == 'LHHT-GOV-008')
        security_harnessrisk = next(source for source in security['sources']
                                    if source['source_id'] == 'harnessrisk')
        governance_harnessrisk = next(source for source in governance['sources']
                                      if source['source_id'] == 'harnessrisk')
        self.assertTrue(security_harnessrisk['support_url'].endswith('#S2.SS2.p5.1'))
        self.assertTrue(governance_harnessrisk['support_url'].endswith('#S2.SS2.p6.1'))
        self.assertEqual(value['research_map_version'],
                         'lhht-research/2026-09-07.1')
        self.assertGreaterEqual(len(value['research_foundation']), 10)
        self.assertTrue(any(item['name_zh'] != item['name_en'] for item in value['tags']))
        self.assertTrue(all(item['detection_signals'] and item['exclusions']
                            for item in value['tags']))

    def test_global_turn_references_canonicalize_to_atif_turn_ids(self):
        turns = [
            {'turn_id': 'root:step-1', 'global_turn': 1},
            {'turn_id': 'child:step-9', 'global_turn': 40},
        ]
        by_id = {item['turn_id']: item for item in turns}
        by_number = {item['global_turn']: item for item in turns}
        self.assertEqual(_canonical_turn_id('child:step-9', by_id, by_number),
                         'child:step-9')
        self.assertEqual(_canonical_turn_id('Turn 40', by_id, by_number),
                         'child:step-9')
        self.assertEqual(_canonical_turn_id('40', by_id, by_number),
                         'child:step-9')
        self.assertIsNone(_canonical_turn_id('999', by_id, by_number))

    def test_malformed_structured_model_output_is_retryable(self):
        self.assertTrue(_retryable_codex_error(
            CodexError('Codex analysis did not return valid JSON'),
        ))

    def test_task_analysis_tools_expose_independent_evidence_without_ordering(self):
        turns = [{
            'turn_id': f'root:{index}', 'global_turn': index,
            'trajectory_id': 'root', 'agent_role': 'planner', 'agent_name': 'agent',
            'tool_calls': [], 'message': f'message {index}',
        } for index in range(1, 4)]
        trace = {
            'turns': turns, 'turn_count': 3, 'agent_count': 1,
            'agents': [{'trajectory_id': 'root', 'assignment': 'do task', 'parent': None}],
            'call_edges': [], 'analysis_input_quality': {},
        }
        specs, handler, state = _agentic_tools(
            {'task_id': '003'}, {'score': 0}, trace,
            {'available': False, 'reason': 'test'},
        )
        self.assertEqual({item['name'] for item in specs}, {
            'get_task_context', 'get_trajectory', 'get_turn_detail',
            'get_call_graph', 'get_evaluator', 'get_artifact',
        })
        context = handler('get_task_context', {})
        self.assertEqual(context['turn_count'], 3)
        self.assertEqual(context['instruction'], 'do task')
        self.assertEqual(state['turns_read'], set())
        page = handler('get_trajectory', {'start': 2, 'limit': 1})
        self.assertEqual([item['turn_id'] for item in page['turns']], ['root:2'])
        self.assertEqual(state['turns_read'], {'root:2'})
        self.assertEqual(handler('get_turn_detail', {'turn_id': 'Turn 3'})['turn_id'],
                         'root:3')
        self.assertEqual(handler('get_evaluator', {})['evaluation']['score'], 0)
        self.assertFalse(handler('get_artifact', {'path': 'output.txt'})['available'])

    def test_product_analysis_targets_are_not_deadlines(self):
        self.assertEqual(TASK_ANALYSIS_TARGET_SECONDS, 120)
        self.assertEqual(RUN_ANALYSIS_TARGET_SECONDS, 900)

    def test_task_synthesis_validates_references_without_requiring_a_tool_flow(self):
        trace = {
            'turns': [{'turn_id': 'root:1', 'global_turn': 1}],
            'agents': [{'trajectory_id': 'root'}],
        }
        _validate_task_synthesis({'turns': [], 'main_issues': [],
                                  'execution_phases': [], 'call_relationships': {},
                                  'evaluator_analysis': {}}, trace)
        with self.assertRaises(CodexError):
            _validate_task_synthesis({
                'turns': [{'turn_id': 'missing'}], 'main_issues': [],
                'execution_phases': [], 'call_relationships': {},
                'evaluator_analysis': {},
            }, trace)

    def test_run_tools_require_every_task_analysis_before_taxonomy(self):
        tasks = [{
            'task_key': f'000{index}-003', 'task_id': '003', 'status': 'succeeded',
            'score': 0, 'duration_ms': 1, 'agent_outcome': 'succeeded',
            'evaluation_status': 'succeeded',
        } for index in (1, 2)]
        task_results = [{
            'task': task, 'analysis_status': 'reused', 'analysis_error': '',
            'report': {'report_id': f"report-{task['task_key']}", 'revision': 1,
                       'document': {'conclusion': {'summary': 'done'},
                                    'main_issues': [], 'evaluator_analysis': {}}},
        } for task in tasks]
        _, handler, state = self.service._run_aggregation_tools(
            task_results, self.store.taxonomy(),
        )
        with self.assertRaises(ValueError):
            handler('get_taxonomy', {})
        page = handler('list_task_analyses', {'start': 1, 'limit': 2})
        self.assertEqual(len(page['task_analyses']), 2)
        self.assertEqual(state['tasks_read'], {item['task_key'] for item in tasks})
        self.assertEqual(handler('get_taxonomy', {})['version'],
                         'lhht/2026-09-07.1')

    def test_run_synthesis_rejects_singletons_and_invented_task_issue_titles(self):
        titles = {'0001-003': {'验证范围不足'}, '0002-003': {'验证范围不足'}}
        base = {
            'title': '局部验证', 'description': '只检查表象', 'impact': '遗漏状态',
            'severity': 'high', 'confidence': .8, 'taxonomy_id': '',
            'taxonomy_mapping_rationale': '',
            'affected_task_keys': ['0001-003', '0002-003'],
            'typical_tasks': [{'task_key': '0001-003',
                               'evidence_summary': '没有检查持久状态',
                               'issue_titles': ['验证范围不足']}],
        }
        self.service._validate_run_synthesis(
            {'common_problems': [base]}, titles, {'LHHT-VER-004'},
        )
        with self.assertRaises(CodexError):
            self.service._validate_run_synthesis(
                {'common_problems': [{**base,
                                      'affected_task_keys': ['0001-003']}]},
                titles, {'LHHT-VER-004'},
            )
        with self.assertRaises(CodexError):
            self.service._validate_run_synthesis(
                {'common_problems': [{**base, 'typical_tasks': [{
                    'task_key': '0001-003', 'evidence_summary': 'x',
                    'issue_titles': ['虚构标题'],
                }]}]}, titles, {'LHHT-VER-004'},
            )

    def test_state_returns_native_report_and_job(self):
        report = self.store.save_task_report(
            'run-1', '0001-003', 'gpt-a', 'digest', '# report',
            {'issues': [], 'executive_summary': 'summary'},
        )
        job, _ = self.store.create_job('task', 'run-1', '0001-003', 'gpt-a')
        self.store.update_job(job['job_id'], 'completed')
        value = self.service.state(run='run-1', task='0001-003')
        self.assertEqual(value['report']['report_id'], report['report_id'])
        self.assertEqual(value['report_origin'], 'backend-native')
        self.assertEqual(value['job']['status'], 'completed')
        self.assertEqual(value['report']['payload']['research_basis']['version'],
                         'lhht-research/2026-09-07.1')

    def test_execution_report_markdown_is_process_first_and_has_no_taxonomy_sections(self):
        document = {
            'run_id': 'run-1', 'task_key': '0001-003',
            'conclusion': {'summary': '完成核心修改，停在复核阶段。',
                           'completion': 'substantially_complete',
                           'execution_quality': 'effective_with_gaps',
                           'current_state': '等待复核', 'stuck': False,
                           'stuck_reason': ''},
            'main_issues': [{'title': '没有完成复核', 'description': '轨迹在复核前结束。',
                             'impact': '缺少自主确认', 'severity': 'medium',
                             'status': 'unresolved', 'turn_ids': ['root:2']}],
            'call_relationships': {'summary': '单 Agent 执行。',
                                   'agents': [], 'edges': []},
            'execution_phases': [{'title': '修改', 'summary': '写入结果。',
                                  'result': '写入完成', 'status': 'completed',
                                  'turn_ids': ['root:2']}],
            'turns': [{'turn_id': 'root:2', 'global_turn': 1,
                       'trajectory_id': 'root', 'agent_name': 'agent', 'at_ms': 100,
                       'purpose': '写入结果', 'action': '修改目标对象',
                       'result': '修改完成', 'progress': '核心工作完成',
                       'assessment': 'effective'}],
            'evaluator_analysis': {'score': 1.0, 'summary': '目标状态正确。',
                                   'method': '读取最终状态', 'criteria': [],
                                   'execution_discrepancy': '未检查自主复核。'},
        }
        markdown = self.service._task_markdown(document)
        self.assertLess(markdown.index('## 执行过程'),
                        markdown.index('## Evaluator 评分分析'))
        self.assertIn('## 单 Turn 描述', markdown)
        self.assertNotIn('Taxonomy', markdown)
        self.assertNotIn('做得好的地方', markdown)
        self.assertNotIn('Agent 结果', markdown)

    def test_report_list_returns_only_latest_revision_per_run(self):
        first = self.store.save_run_report('run-1', 'gpt-a', '# first', {'issues': []})
        latest = self.store.save_run_report('run-1', 'gpt-a', '# latest', {'issues': []})
        other = self.store.save_run_report('run-2', 'gpt-a', '# other', {'issues': []})
        reports = self.store.list_run_reports()
        self.assertEqual(len(reports), 2)
        self.assertNotIn(first['report_id'], {item['report_id'] for item in reports})
        self.assertEqual({latest['report_id'], other['report_id']},
                         {item['report_id'] for item in reports})
        self.assertEqual(self.service.report(first['report_id'])['report_id'],
                         latest['report_id'])

    def test_run_report_becomes_stale_when_a_task_report_changes(self):
        task_report = self.store.save_task_report(
            'run-1', '0001-003', 'gpt-a', 'digest', '# task', {
                'schema_version': 'task-execution-analysis/v1',
                'pipeline_version': PIPELINE_VERSION, 'main_issues': [],
            },
        )
        run_report = self.store.save_run_report('run-1', 'gpt-a', '# run', {
            'schema_version': 'aft-run-report/v2',
            'pipeline_version': RUN_PIPELINE_VERSION,
            'tasks': [{'task_key': '0001-003',
                       'task_report_id': task_report['report_id']}],
            'summary': {}, 'issues': [],
        })
        self.assertTrue(self.service._current_run_report(
            run_report, 'gpt-a', {'0001-003'},
        ))
        self.store.save_task_report(
            'run-1', '0001-003', 'gpt-a', 'digest-2', '# task 2', {
                'schema_version': 'task-execution-analysis/v1',
                'pipeline_version': PIPELINE_VERSION, 'main_issues': [],
            },
        )
        self.assertFalse(self.service._current_run_report(
            run_report, 'gpt-a', {'0001-003'},
        ))

    def test_report_persists_evidence_and_facets(self):
        report = self.store.save_task_report(
            'run-1', '0001-003', 'gpt-a', 'digest', '# report', {'issues': [{
                'issue_id': 'issue-1', 'summary': 'Problem', 'severity': 'high',
                'confidence': .8, 'responsibility': 'model', 'mapping_status': 'mapped',
                'facets': ['wrong_file'],
                'tag_mapping': {'primary_tag': 'LHHT-VER-004',
                                'confidence': .8, 'rationale': 'trace evidence'},
                'evidence': [{'trajectory_id': 'root', 'turn_id': 'root:2',
                              'tool_call_id': 'call-1', 'timestamp_ms': 1200,
                              'role': 'first_bad', 'excerpt': 'wrong path'}],
            }]},
        )
        evidence = self.store.db.execute(
            "SELECT * FROM issue_evidence WHERE issue_id LIKE ?", ('%:issue-1',),
        ).fetchall()
        facets = self.store.db.execute(
            "SELECT facet FROM issue_facets WHERE issue_id LIKE ?", ('%:issue-1',),
        ).fetchall()
        self.assertEqual(report['taxonomy_version'], 'lhht/2026-09-07.1')
        self.assertEqual(len(evidence), 1)
        self.assertEqual([row['facet'] for row in facets], ['wrong_file'])
        second = self.store.save_task_report(
            'run-1', '0001-003', 'gpt-a', 'digest', '# report 2',
            {'issues': [{'issue_id': 'issue-1', 'summary': 'Problem',
                         'severity': 'high', 'confidence': .8,
                         'responsibility': 'model', 'mapping_status': 'unmapped'}]},
        )
        self.assertEqual(second['revision'], report['revision'] + 1)

    def test_start_validates_terminal_model_and_schedules_once(self):
        self.service._execution_summary = Mock(return_value=({'status': 'succeeded'}, {}, {}))
        self.service._submit = Mock()
        value = self.service.start(run='run-1', task='0001-003', model='gpt-a')
        self.assertEqual(value['job']['status'], 'queued')
        self.service._submit.assert_called_once()
        self.service.start(run='run-1', task='0001-003', model='gpt-a')
        self.service._submit.assert_called_once()
        self.store.save_task_report('run-1', '0001-003', 'gpt-a', 'd', '# r', {'issues': []})
        self.service.start(run='run-1', task='0001-003', model='gpt-a', force=True)
        # The already-active job is reused instead of scheduling a duplicate.
        self.service._submit.assert_called_once()
        self.store.update_job(value['job']['job_id'], 'completed')
        self.service.start(run='run-1', task='0001-003', model='gpt-a', force=True)
        self.assertEqual(self.service._submit.call_count, 2)
        self.assertFalse(self.service._submit.call_args.kwargs['reuse_cache'])
        with self.assertRaises(InvalidQuery):
            self.service.start(run='run-1', task='0001-003', model='not-listed')
        self.service._execution_summary.return_value = ({'status': 'running'}, {}, {})
        live = self.service.start(run='run-2', task='0001-003', model='gpt-a')
        self.assertEqual(live['job']['status'], 'queued')

    def test_unknown_execution_is_rejected_without_analysis(self):
        with self.assertRaises(ResourceNotFound):
            self.service.state(run='run-1', task='other')

    def test_run_document_contains_task_scores_common_problems_and_evidence(self):
        tasks = [{
            'task_key': '0001-003', 'task_id': '003', 'score': 0,
            'duration_ms': 1200, 'status': 'succeeded',
            'agent_outcome': 'failed', 'evaluation_status': 'succeeded',
        }, {
            'task_key': '0002-003', 'task_id': '003', 'score': .5,
            'duration_ms': 800, 'status': 'succeeded',
            'agent_outcome': 'succeeded', 'evaluation_status': 'succeeded',
        }]
        task_results = [{
            'task': task, 'analysis_status': 'reused', 'analysis_error': '',
            'report': {'report_id': f"report-{task['task_key']}", 'revision': 1,
                       'document': {
                           'conclusion': {'summary': '完成但缺少完整验证',
                                          'completion': 'substantially_complete',
                                          'execution_quality': 'effective_with_gaps'},
                           'main_issues': [{'title': '验证范围不足'}],
                       }},
        } for task in tasks]
        synthesis = {'executive_summary': 'global', 'common_problems': [{
            'title': '只验证局部结果', 'description': '两个任务都只检查了局部表象。',
            'impact': '未发现实际状态缺口', 'severity': 'high', 'confidence': .9,
            'taxonomy_id': 'LHHT-VER-004',
            'taxonomy_mapping_rationale': '单任务报告均记录了局部验证与反证。',
            'affected_task_keys': ['0001-003', '0002-003'],
            'typical_tasks': [
                {'task_key': '0001-003', 'evidence_summary': '只检查可见页面。',
                 'issue_titles': ['验证范围不足']},
                {'task_key': '0002-003', 'evidence_summary': '没有检查持久状态。',
                 'issue_titles': ['验证范围不足']},
            ],
        }]}
        document = self.service._build_run_document(
            'run-1', 'gpt-a', task_results, synthesis, [], 'skill-digest',
        )
        self.assertEqual(document['summary']['failed'], 1)
        self.assertEqual(document['summary']['agent_failures'], 1)
        self.assertEqual(document['schema_version'], 'aft-run-report/v2')
        self.assertEqual(document['pipeline_version'], RUN_PIPELINE_VERSION)
        self.assertEqual(len(document['common_problems'][0]['tasks']), 2)
        self.assertEqual(len(document['common_problems'][0]['instances']), 2)
        self.assertEqual(document['common_problems'][0]['taxonomy']['tag_id'],
                         'LHHT-VER-004')
        markdown = self.service._run_markdown(document)
        self.assertIn('/tasks/0001-003?panel=aft', markdown)
        self.assertIn('## Task 评分表格', markdown)
        self.assertIn('## 共性问题分析', markdown)
        self.assertIn('典型 Task 证据', markdown)
        report = self.store.save_run_report('run-1', 'gpt-a', markdown, document)
        self.assertEqual(report['run_id'], 'run-1')
        self.assertEqual(report['taxonomy_version'], 'lhht/2026-09-07.1')

    def test_analysis_cache_round_trip(self):
        self.assertIsNone(self.store.cached_analysis('cache-key'))
        self.store.cache_analysis(
            'cache-key', stage='pass-a', digest='digest', model='gpt-a',
            pipeline_version='pass-a/v1', taxonomy_version=None,
            payload={'turn_ids': ['root:1'], 'result': {'issues': []}},
        )
        self.assertEqual(self.store.cached_analysis('cache-key')['turn_ids'], ['root:1'])

    def test_run_analyzer_reuses_current_task_reports_before_aggregation(self):
        directory = tempfile.TemporaryDirectory()
        store = AftStore(directory.name + '/aft.sqlite3')
        catalog = Mock()
        catalog.reader = Reader()
        service = ExecutionAnalysisService(catalog, Mock(), store, Codex(), workers=20)
        tasks = [{
            'task_key': f'{index:04d}-001', 'task_id': '001', 'score': 1,
            'duration_ms': 1, 'status': 'succeeded', 'agent_outcome': 'succeeded',
            'evaluation_status': 'succeeded',
        } for index in range(30)]
        service.catalog.get_batch.return_value = {'tasks': tasks}
        try:
            for task in tasks:
                store.save_task_report(
                    'run-100', task['task_key'], 'gpt-a', 'digest', '# task', {
                        'schema_version': 'task-execution-analysis/v1',
                        'pipeline_version': PIPELINE_VERSION,
                        'conclusion': {'summary': '完成', 'completion': 'complete',
                                       'execution_quality': 'effective'},
                        'main_issues': [], 'evaluator_analysis': {},
                    },
                )
            service._analyze_task = Mock(side_effect=AssertionError('must not run'))
            def analyze_run(*args, **kwargs):
                handler = kwargs['tool_handler']
                for start in (1, 26):
                    handler('list_task_analyses', {'start': start, 'limit': 25})
                    kwargs['tool_audit'].append(
                        {'tool': 'list_task_analyses', 'success': True}
                    )
                handler('get_taxonomy', {})
                kwargs['tool_audit'].append({'tool': 'get_taxonomy', 'success': True})
                return {'executive_summary': 'ok', 'common_problems': []}
            service._run_codex = Mock(side_effect=analyze_run)
            job, _ = store.create_job('run', 'run-100', None, 'gpt-a')
            service._execute_run_job(job['job_id'])
            finished = store.job(job['job_id'])
            self.assertEqual(finished['status'], 'completed')
            self.assertEqual(finished['progress']['completed'], 30)
            service._analyze_task.assert_not_called()
            service._run_codex.assert_called_once()
            report = store.latest_run_report('run-100')
            self.assertEqual(report['document']['analysis_workflow']
                             ['task_reports_reused'], 30)
        finally:
            service.close()
            directory.cleanup()

    def test_run_analyzer_generates_missing_task_reports_in_parallel(self):
        directory = tempfile.TemporaryDirectory()
        store = AftStore(directory.name + '/aft.sqlite3')
        catalog = Mock()
        catalog.reader = Reader()
        service = ExecutionAnalysisService(catalog, Mock(), store, Codex(), workers=4)
        tasks = [{
            'task_key': f'{index:04d}-001', 'task_id': '001', 'score': 1,
            'duration_ms': 1, 'status': 'succeeded', 'agent_outcome': 'succeeded',
            'evaluation_status': 'succeeded',
        } for index in range(4)]
        service.catalog.get_batch.return_value = {'tasks': tasks}
        barrier = threading.Barrier(4, timeout=2)

        def analyze_task(run, task_key, model, **_kwargs):
            barrier.wait()
            return store.save_task_report(
                run, task_key, model, 'digest', '# task', {
                    'schema_version': 'task-execution-analysis/v1',
                    'pipeline_version': PIPELINE_VERSION,
                    'conclusion': {'summary': '完成', 'completion': 'complete',
                                   'execution_quality': 'effective'},
                    'main_issues': [], 'evaluator_analysis': {},
                },
            )

        try:
            service._analyze_task = Mock(side_effect=analyze_task)
            def analyze_run(*args, **kwargs):
                handler = kwargs['tool_handler']
                handler('list_task_analyses', {'start': 1, 'limit': 25})
                kwargs['tool_audit'].append(
                    {'tool': 'list_task_analyses', 'success': True}
                )
                handler('get_taxonomy', {})
                kwargs['tool_audit'].append({'tool': 'get_taxonomy', 'success': True})
                return {'executive_summary': 'ok', 'common_problems': []}
            service._run_codex = Mock(side_effect=analyze_run)
            job, _ = store.create_job('run', 'run-parallel', None, 'gpt-a')
            service._execute_run_job(job['job_id'])
            self.assertEqual(store.job(job['job_id'])['status'], 'completed')
            self.assertEqual(service._analyze_task.call_count, 4)
            report = store.latest_run_report('run-parallel')
            self.assertEqual(report['document']['analysis_workflow']
                             ['task_reports_generated'], 4)
        finally:
            service.close()
            directory.cleanup()


if __name__ == '__main__':
    unittest.main()
