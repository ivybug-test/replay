"""Exercise HTTP dispatch/contracts with injected services, without OSS access."""

import unittest
import urllib.error
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.catalog import CatalogService
from backend.oss_io.client import OssError, OssNoSuchKey, OssObjectTooLarge, OssProtocolError
from backend.replay import ReplayService
from backend.services import (
    ImageContent, InvalidQuery, ResourceNotFound, ServiceUnavailable,
)

RUN = "20260904T065242Z-qwen38-thinkhi-0904"
TASK = "0001-003"
EXECUTION = {"run": RUN, "task": TASK}
DIGEST = "a" * 64
PNG = b"\x89PNG\r\n\x1a\nfixture"


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.catalog = Mock(spec=CatalogService)
        self.replay = Mock(spec=ReplayService)
        self.client = TestClient(create_app(catalog=self.catalog, replay=self.replay))
        self.addCleanup(self.client.close)

    def test_catalog_dispatch_preserves_payload_and_frontend_envelope(self):
        payload = {"date": "2026-09-04", "latest_date": "2026-09-04", "runs": [{"batch_id": RUN}]}
        self.catalog.list_runs.return_value = payload
        response = self.client.get("/api/runs", params={"date": "2026-09-04"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)
        self.catalog.list_runs.assert_called_once_with(date="2026-09-04")
        self.client.get("/api/runs")
        self.catalog.list_runs.assert_called_with(date=None)
        batch = {"batch_id": RUN, "tasks": [{"key": TASK, "task_id": "003"}]}
        self.catalog.get_batch.return_value = batch
        response = self.client.get("/api/batch", params={"run": RUN})
        self.assertEqual(response.json(), {"batch": batch})
        self.catalog.get_batch.assert_called_once_with(run=RUN)

    def test_task_history_preserves_identity_filters_paging_and_sync_state(self):
        payload = {"task_id": "003", "runs": [{"batch_id": RUN, "task_key": TASK, "score": None}],
                   "next_cursor": "more", "sync": {"status": "syncing"}}
        self.catalog.list_task_runs.return_value = payload
        response = self.client.get("/api/task-runs", params={
            "task_id": "003", "cursor": "token+/=", "limit": "20", "model": "vendor/model", "status": "running",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)
        self.catalog.list_task_runs.assert_called_once_with(
            task_id="003", cursor="token+/=", limit=20, model="vendor/model", status="running",
        )
        self.client.get("/api/task-runs", params={"task_id": "003"})
        self.catalog.list_task_runs.assert_called_with(task_id="003", cursor=None, limit=50, model=None, status=None)

    def test_replay_dispatch_keeps_source_documents_and_typed_arguments(self):
        routes = [
            ("trajectory", "get_trajectory", {}, {}),
            ("atif-live", "get_atif_live", {"after": "17"}, {"after": 17}),
            ("agent-work", "get_agent_work", {"center_ms": "-1"},
             {"center_ms": -1, "before_ms": None, "after_ms": None}),
            ("window", "get_window", {"center_ms": "0", "before_ms": "5000", "after_ms": "5000", "include_timeline": "0"},
             {"center_ms": 0, "before_ms": 5000, "after_ms": 5000, "include_timeline": False}),
            ("execution-state", "get_execution_state", {}, {}),
        ]
        for path, method, extra, expected in routes:
            with self.subTest(path=path):
                service = getattr(self.replay, method)
                payload = {"version": "source-schema/v1", "events": [], "extra": {"future": 1}}
                service.return_value = payload
                response = self.client.get(f"/api/{path}", params={**EXECUTION, **extra})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), payload)
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                service.assert_called_once_with(**EXECUTION, **expected)

    def test_live_and_window_defaults_and_optional_work_spans(self):
        for name in ("get_atif_live", "get_window", "get_agent_work"):
            getattr(self.replay, name).return_value = {}
        self.client.get("/api/atif-live", params=EXECUTION)
        self.replay.get_atif_live.assert_called_with(**EXECUTION, after=0)
        self.client.get("/api/window", params=EXECUTION)
        self.replay.get_window.assert_called_with(**EXECUTION, center_ms=-1, before_ms=30000,
                                                 after_ms=60000, include_timeline=True)
        self.client.get("/api/agent-work", params={**EXECUTION, "center_ms": "120000", "before_ms": "5000"})
        self.replay.get_agent_work.assert_called_with(**EXECUTION, center_ms=120000, before_ms=5000, after_ms=None)

    def test_media_routes_return_binary_content_and_preserve_resource_arguments(self):
        for route, method, values, expected in (
            ("frame", "get_frame", {"frame": "0"}, {"frame": 0}),
            ("model-image", "get_model_image", {"path": "images/中 +%.png", "sha256": DIGEST},
             {"path": "images/中 +%.png", "sha256": DIGEST}),
            ("atif-media", "get_atif_media", {"path": "replay/frames/p.png"}, {"path": "replay/frames/p.png"}),
        ):
            with self.subTest(route=route):
                service = getattr(self.replay, method)
                service.return_value = ImageContent(PNG, "image/png")
                response = self.client.get(f"/api/{route}", params={**EXECUTION, **values})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, PNG)
                self.assertEqual(response.headers["Content-Type"], "image/png")
                self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                service.assert_called_once_with(**EXECUTION, **expected)

    def test_invalid_queries_never_reach_services(self):
        cases = [
            ("batch", {}), ("batch", {"run": "../other"}),
            ("trajectory", {"run": RUN}), ("trajectory", {**EXECUTION, "task": "../other"}),
            ("runs", {"date": "2026-02-30"}), ("runs", {"date": "20260904"}),
            ("task-runs", {"task_id": "osworld-v2-003"}), ("task-runs", {"task_id": "3"}),
            ("task-runs", {"task_id": "003", "limit": "101"}),
            ("task-runs", {"task_id": "003", "cursor": ""}),
            ("atif-live", {**EXECUTION, "after": "-1"}),
            ("atif-live", {**EXECUTION, "after": "1000001"}),
            ("window", {**EXECUTION, "center_ms": "-2"}),
            ("window", {**EXECUTION, "before_ms": "120001"}),
            ("window", {**EXECUTION, "include_timeline": "unknown"}),
            ("agent-work", {**EXECUTION, "center_ms": "nan"}),
            ("frame", {**EXECUTION, "frame": "-1"}),
            ("model-image", {**EXECUTION, "path": "images/a.png", "sha256": "bad"}),
        ]
        for route, params in cases:
            with self.subTest(route=route, params=params):
                response = self.client.get(f"/api/{route}", params=params)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json()["error"]["code"], "invalid_parameters")
        self.assertEqual(self.catalog.mock_calls, [])
        self.assertEqual(self.replay.mock_calls, [])

    def test_media_paths_are_relative_and_decoded_only_once(self):
        for path in ("../secret", "/etc/passwd", "images/../secret", "a//b", "a/./b",
                     "https://example.org/img", "a\\b", "images/a\x00.png"):
            with self.subTest(path=path):
                response = self.client.get("/api/atif-media", params={**EXECUTION, "path": path})
                self.assertEqual(response.status_code, 422)
        self.assertEqual(self.replay.mock_calls, [])
        self.replay.get_atif_media.return_value = ImageContent(PNG, "image/png")
        self.client.get("/api/atif-media", params={**EXECUTION, "path": "images/literal%20name.png"})
        self.replay.get_atif_media.assert_called_once_with(**EXECUTION, path="images/literal%20name.png")

    def test_errors_keep_missing_unavailable_upstream_and_bad_query_distinct(self):
        errors = [
            (ResourceNotFound("sensitive"), 404, "not_found"),
            (OssNoSuchKey(404, "NoSuchKey", "sensitive"), 404, "not_found"),
            (ServiceUnavailable("sensitive"), 503, "service_unavailable"),
            (InvalidQuery("sensitive"), 400, "invalid_query"),
            (OssError(403, "AccessDenied", "sensitive"), 502, "upstream_error"),
            (OssError(404, "NoSuchBucket", "sensitive"), 502, "upstream_error"),
            (OssProtocolError("sensitive"), 502, "invalid_artifact"),
            (OssObjectTooLarge("sensitive"), 502, "artifact_too_large"),
            (TimeoutError("sensitive"), 504, "upstream_timeout"),
            (urllib.error.URLError(TimeoutError("sensitive")), 504, "upstream_timeout"),
            (urllib.error.URLError("sensitive"), 502, "upstream_error"),
        ]
        for error, status, code in errors:
            with self.subTest(error=error):
                self.replay.get_trajectory.side_effect = error
                response = self.client.get("/api/trajectory", params=EXECUTION)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["error"]["code"], code)
                self.assertNotIn("sensitive", response.text)

    def test_internal_error_is_sanitized_and_does_not_escape_asgi(self):
        self.replay.get_trajectory.side_effect = RuntimeError("secret credential")
        with self.assertLogs("backend.app", level="ERROR") as logs:
            response = self.client.get("/api/trajectory", params=EXECUTION)
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("secret credential", response.text + str(logs.output))

    def test_image_size_and_mime_are_checked_before_sending_body(self):
        self.replay.get_frame.return_value = ImageContent(b"<html>bad</html>", "text/html")
        response = self.client.get("/api/frame", params={**EXECUTION, "frame": 0})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["error"]["code"], "invalid_artifact")
        self.replay.get_frame.return_value = ImageContent(PNG, "image/png")
        with patch("backend.router.MAX_IMAGE_BYTES", 2):
            response = self.client.get("/api/frame", params={**EXECUTION, "frame": 0})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["error"]["code"], "artifact_too_large")

    def test_unknown_routes_and_write_methods_are_rejected(self):
        for path in ("/api/tasks", "/api/chat", "/api/unknown", "/"):
            self.assertEqual(self.client.get(path).status_code, 404)
        response = self.client.post("/api/runs")
        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.headers["Allow"], "GET")
        self.assertEqual(self.catalog.mock_calls, [])


class AppFactoryTests(unittest.TestCase):
    def test_unwired_services_return_503_but_health_docs_and_validation_work(self):
        with TestClient(create_app()) as client:
            health = client.get("/api/health")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(health.json()["services_configured"], {"catalog": False, "replay": False})
            cases = {
                "runs": {}, "batch": {"run": RUN}, "task-runs": {"task_id": "003"},
                "trajectory": EXECUTION, "atif-live": EXECUTION, "agent-work": EXECUTION,
                "window": EXECUTION, "execution-state": EXECUTION,
                "frame": {**EXECUTION, "frame": 0}, "atif-media": {**EXECUTION, "path": "a.png"},
                "model-image": {**EXECUTION, "path": "a.png", "sha256": DIGEST},
            }
            for route, params in cases.items():
                with self.subTest(route=route):
                    self.assertEqual(client.get(f"/api/{route}", params=params).status_code, 503)
            self.assertEqual(client.get("/api/trajectory").status_code, 422)
            self.assertEqual(client.get("/api/docs").status_code, 200)
            schema = client.get("/api/openapi.json").json()
            self.assertEqual(set(schema["paths"]), {f"/api/{route}" for route in cases} | {"/api/health"})
            params = schema["paths"]["/api/atif-live"]["get"]["parameters"]
            self.assertEqual({p["name"] for p in params}, {"run", "task", "after"})
            self.assertTrue(all(p["in"] == "query" for p in params))
            error_schema = schema["paths"]["/api/atif-live"]["get"]["responses"]["422"]["content"]["application/json"]["schema"]
            self.assertEqual(error_schema["$ref"], "#/components/schemas/ErrorResponse")


if __name__ == "__main__":
    unittest.main()
