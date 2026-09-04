"""OSS wire contract, independent signature vectors, and bounded-read failures.

Run from the repository root:
    python3 -m unittest discover -s backend/tests -v
No credentials, OSS writes, external services, or third-party packages needed.
"""

import http.client
import io
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

from backend.oss_io.client import (
    MAX_LIST_BYTES, NotModified, OssClient, OssError, OssNoSuchKey,
    OssObjectTooLarge, OssProtocolError, env_credentials,
)
from backend.oss_io.file import read_bytes

CREDENTIALS = {
    "endpoint": "http://oss-cn-heyuan-internal.aliyuncs.com",
    "bucket": "bkt", "region": "cn-heyuan",
    "access_key_id": "ak", "access_key_secret": "sk",
}
NOW = datetime(2026, 8, 20, 12, tzinfo=timezone.utc).timestamp()
MODIFIED = "Thu, 20 Aug 2026 12:00:00 GMT"


def headers(values=None):
    result = Message()
    for key, value in (values or {}).items():
        result[key] = value
    return result


class Response(io.BytesIO):
    status = 200

    def __init__(self, body=b"", metadata=None):
        super().__init__(body)
        self.headers = headers(metadata)
        self.reads = []

    def read(self, size=-1):
        self.reads.append(size)
        return super().read(size)


def make_client(response=None, error=None):
    opener = Mock()
    opener.open.return_value = response if response is not None else Response()
    opener.open.side_effect = error
    return OssClient(CREDENTIALS, clock=lambda: NOW, timeout=3, opener=opener), opener


def error_response(status, code="", message="failed"):
    body = io.BytesIO(f"<Error><Code>{code}</Code><Message>{message}</Message></Error>".encode())
    return urllib.error.HTTPError(
        "http://bkt.invalid/key", status, "failure",
        headers({"x-oss-request-id": "req-123"}), body,
    ), body


def page_xml(contents="", *, truncated=False, cursor=None, encoded=False):
    return (
        '<ListBucketResult xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com">'
        f'<IsTruncated>{str(truncated).lower()}</IsTruncated>'
        + ('<EncodingType>url</EncodingType>' if encoded else '')
        + (f'<NextContinuationToken>{cursor}</NextContinuationToken>' if cursor else '')
        + contents + '</ListBucketResult>'
    ).encode()


def object_xml(key="harness/batch.json", size="3"):
    return (f'<Contents><Key>{key}</Key><Size>{size}</Size><ETag>"e1"</ETag>'
            '<LastModified>2026-08-20T12:00:00.000Z</LastModified></Contents>')


class SigningAndConfigTests(unittest.TestCase):
    def test_signatures_match_frozen_official_oss2_authv4_vectors(self):
        # Captured independently from oss2.AuthV4 at the frozen UTC time above.
        # Includes conditional GET, UTF-8 paths, and V2 opaque query tokens.
        cases = [
            ("bench/harness/b1/tasks/0001-001/r1/result.json", {},
             "87117a938933bc29185ff6420f9c901b5c051a9a1faa561079bb87db235aa017"),
            ("bench/中文 a+%?#.json", {"if_none_match": '"etag-1"'},
             "3304c62080dd0a7129d9dc625e8fc91a0fd83a5aee76f815b152d6acd9e1a61b"),
            (None, {}, "f2161a59c96cb73bab9906d175d2e5001ffab5abbf4b278fe511f161b2fd731d"),
        ]
        for key, kwargs, signature in cases:
            with self.subTest(key=key):
                client, opener = make_client(Response(page_xml()))
                if key is None:
                    client.list_objects("bench/中文 +/", delimiter="/", limit=2, cursor="a+/=% token")
                else:
                    client.get_object(key, **kwargs).close()
                request = opener.open.call_args.args[0]
                self.assertEqual(request.get_method(), "GET")
                self.assertEqual(request.get_header("Authorization"),
                                 "OSS4-HMAC-SHA256 Credential=ak/20260820/cn-heyuan/oss/aliyun_v4_request, "
                                 f"Signature={signature}")
                self.assertEqual(opener.open.call_args.kwargs, {"timeout": 3})
                if kwargs:
                    self.assertEqual(request.get_header("If-none-match"), '"etag-1"')
                    self.assertIn("%E4%B8%AD%E6%96%87%20a%2B%25%3F%23.json", request.full_url)

    def test_configuration_is_copied_and_does_not_fall_back_to_vm_credentials(self):
        creds = dict(CREDENTIALS)
        opener = Mock()
        opener.open.return_value = Response()
        client = OssClient(creds, opener=opener)
        creds["bucket"] = "changed"
        client.get_object("key").close()
        self.assertIn("//bkt.", opener.open.call_args.args[0].full_url)
        with self.assertRaisesRegex(ValueError, "access_key_id"):
            OssClient(env_credentials({"ALIYUN_ACCESS_KEY_ID": "vm-id", "ALIYUN_ACCESS_KEY_SECRET": "vm-secret"}))
        for timeout in (0, -1, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                OssClient(CREDENTIALS, timeout=timeout)

    def test_invalid_input_is_rejected_before_network_access(self):
        client, opener = make_client()
        for limit in (0, 1001, True, 1.5):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                client.list_objects("", limit=limit)
        for kwargs in ({"cursor": ""}, {"delimiter": ""}):
            with self.assertRaises(ValueError):
                client.list_objects("", **kwargs)
        with self.assertRaises(ValueError):
            client.get_object("")
        with self.assertRaises(ValueError):
            client.get_object("key", if_none_match='"e"\r\nInjected: yes')
        opener.open.assert_not_called()


class ReadTests(unittest.TestCase):
    def test_get_is_lazy_preserves_metadata_and_closes_on_consumer_failure(self):
        raw = Response(b"abc", {"Content-Length": "3", "ETag": '"e1"',
                                "Last-Modified": MODIFIED, "Content-Type": "image/png"})
        client, _ = make_client(raw)
        with self.assertRaisesRegex(RuntimeError, "consumer"):
            with client.get_object("frame") as stream:
                self.assertEqual(raw.reads, [])
                self.assertEqual((stream.size, stream.etag, stream.last_modified, stream.content_type),
                                 (3, '"e1"', MODIFIED, "image/png"))
                self.assertEqual(stream.read(2), b"ab")
                raise RuntimeError("consumer")
        self.assertTrue(raw.closed)

    def test_conditional_304_has_no_body_and_closes_http_error(self):
        error, body = error_response(304)
        error.headers["ETag"] = '"e1"'
        client, opener = make_client(error=error)
        result = client.get_object("key", if_none_match='"e1"')
        self.assertEqual(result, NotModified('"e1"', None))
        self.assertTrue(body.closed)
        opener.open.assert_called_once()

    def test_missing_object_bucket_access_and_upstream_failure_are_distinct(self):
        for status, code, expected in (
            (404, "NoSuchKey", OssNoSuchKey), (404, "", OssNoSuchKey),
            (404, "NoSuchBucket", OssError), (403, "AccessDenied", OssError),
            (503, "ServiceUnavailable", OssError), (304, "", OssError),
        ):
            with self.subTest(status=status, code=code):
                error, body = error_response(status, code)
                client, opener = make_client(error=error)
                with self.assertRaises(expected) as caught:
                    client.get_object("key")
                self.assertIs(type(caught.exception), expected)
                self.assertEqual(caught.exception.status, status)
                self.assertEqual(caught.exception.request_id, "req-123")
                self.assertTrue(body.closed)
                opener.open.assert_called_once()
        error, _ = error_response(404)
        client, _ = make_client(error=error)
        with self.assertRaises(OssError) as caught:
            client.list_objects("")
        self.assertNotIsInstance(caught.exception, OssNoSuchKey)

    def test_transport_timeout_propagates_without_retry(self):
        failure = urllib.error.URLError(TimeoutError("timed out"))
        client, opener = make_client(error=failure)
        with self.assertRaises(urllib.error.URLError) as caught:
            client.get_object("key")
        self.assertIs(caught.exception, failure)
        opener.open.assert_called_once()

    def test_bounded_read_accepts_exact_limit_and_empty_objects(self):
        for data in (b"", b"abc"):
            raw = Response(data, {"Content-Length": str(len(data))})
            client, _ = make_client(raw)
            self.assertEqual(read_bytes(client, "key", max_bytes=len(data)), data)
            self.assertTrue(raw.closed)

    def test_bounded_read_rejects_declared_and_undeclared_overflow(self):
        for metadata in ({"Content-Length": "4"}, {}):
            raw = Response(b"abcdef", metadata)
            client, _ = make_client(raw)
            with self.assertRaises(OssObjectTooLarge):
                read_bytes(client, "key", max_bytes=3)
            self.assertTrue(raw.closed)
            self.assertEqual(raw.reads, [] if metadata else [4])

    def test_invalid_or_truncated_body_and_mid_read_failure_close_stream(self):
        for length in ("-1", "invalid", "9"):
            raw = Response(b"abc", {"Content-Length": length})
            client, _ = make_client(raw)
            with self.assertRaises(OssProtocolError):
                read_bytes(client, "key", max_bytes=10)
            self.assertTrue(raw.closed)
        raw = Response()
        raw.read = Mock(side_effect=[b"a", TimeoutError("read stalled")])
        client, _ = make_client(raw)
        with self.assertRaises(TimeoutError):
            read_bytes(client, "key", max_bytes=10)
        self.assertTrue(raw.closed)


class ListTests(unittest.TestCase):
    def test_pages_preserve_keys_metadata_prefixes_and_cursor(self):
        first = Response(page_xml(
            object_xml("harness/%E4%B8%AD%20%2B%25.json")
            + '<CommonPrefixes><Prefix>harness/a%2B/</Prefix></CommonPrefixes>',
            truncated=True, cursor="a%2B%2F%3D%25%20token", encoded=True,
        ))
        second = Response(page_xml(object_xml("harness/last.json")))
        client, opener = make_client()
        opener.open.side_effect = [first, second]
        page = client.list_objects("harness/", delimiter="/", limit=2)
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(page.objects[0].key, "harness/中 +%.json")
        self.assertEqual((page.objects[0].size, page.objects[0].etag), (3, '"e1"'))
        self.assertEqual(page.objects[0].last_modified, "2026-08-20T12:00:00.000Z")
        self.assertEqual(page.prefixes, ("harness/a+/",))
        self.assertEqual(page.next_cursor, "a+/=% token")
        final = client.list_objects("harness/", delimiter="/", cursor=page.next_cursor, limit=2)
        self.assertIsNone(final.next_cursor)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(opener.open.call_args.args[0].full_url).query)
        self.assertEqual(query["continuation-token"], ["a+/=% token"])
        self.assertEqual(query["delimiter"], ["/"])
        self.assertEqual(query["list-type"], ["2"])
        self.assertTrue(first.closed and second.closed)

    def test_bad_pages_do_not_silently_become_empty_or_complete(self):
        for body in (
            b"not XML", b"<Error/>", b"<ListBucketResult/>",
            page_xml(truncated=True), page_xml(cursor="unexpected"),
            page_xml(object_xml(size="bad")), page_xml(object_xml(size="-1")),
            page_xml('<Contents><Key>k</Key></Contents>'),
        ):
            with self.subTest(body=body):
                raw = Response(body)
                client, _ = make_client(raw)
                with self.assertRaises(OssProtocolError):
                    client.list_objects("")
                self.assertTrue(raw.closed)
        client, _ = make_client(Response(page_xml(truncated=True, cursor="same")))
        with self.assertRaisesRegex(OssProtocolError, "did not advance"):
            client.list_objects("", cursor="same")

    def test_list_read_is_bounded(self):
        for raw in (Response(b"", {"Content-Length": str(MAX_LIST_BYTES + 1)}),
                    Response(b"x" * 17)):
            client, _ = make_client(raw)
            with patch("backend.oss_io.client.MAX_LIST_BYTES", 16):
                with self.assertRaises(OssObjectTooLarge):
                    client.list_objects("")
            self.assertTrue(raw.closed)


class WireTests(unittest.TestCase):
    def test_real_urllib_get_304_missing_and_pagination(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers))
                parsed = urllib.parse.urlsplit(self.path)
                status, metadata = 200, {}
                if parsed.query:
                    query = urllib.parse.parse_qs(parsed.query)
                    if "continuation-token" in query:
                        body = page_xml()
                    else:
                        body = page_xml('<CommonPrefixes><Prefix>harness/b/</Prefix></CommonPrefixes>',
                                        truncated=True, cursor="next")
                elif parsed.path == "/missing":
                    status, body = 404, b"<Error><Code>NoSuchKey</Code></Error>"
                elif self.headers.get("If-None-Match") == '"e1"':
                    status, body = 304, b""
                else:
                    body, metadata = b"image", {"ETag": '"e1"', "Content-Type": "image/png"}
                self.send_response(status)
                for key, value in metadata.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        class LocalConnection(http.client.HTTPConnection):
            def connect(self):
                # Route the real HTTP transport to a local fixture, preserving
                # the signed URL and Host header for wire assertions.
                self.host, self.port = server.server_address
                super().connect()

        class LocalHandler(urllib.request.HTTPHandler):
            def http_open(self, request):
                return self.do_open(LocalConnection, request)

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), LocalHandler())
        client = OssClient(CREDENTIALS, clock=lambda: NOW, opener=opener)
        self.assertEqual(read_bytes(client, "中 +.png", max_bytes=5), b"image")
        self.assertIsInstance(client.get_object("中 +.png", if_none_match='"e1"'), NotModified)
        with self.assertRaises(OssNoSuchKey):
            client.get_object("missing")
        page = client.list_objects("harness/", delimiter="/")
        self.assertEqual(page.prefixes, ("harness/b/",))
        self.assertIsNone(client.list_objects("harness/", delimiter="/", cursor=page.next_cursor).next_cursor)
        self.assertEqual(len(requests), 5)
        self.assertEqual(requests[0][0], "/%E4%B8%AD%20%2B.png")
        self.assertEqual(requests[0][1]["Host"], "bkt.oss-cn-heyuan-internal.aliyuncs.com")
        self.assertTrue(requests[0][1]["Authorization"].startswith("OSS4-HMAC-SHA256 "))


if __name__ == "__main__":
    unittest.main()
