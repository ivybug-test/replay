"""Read-only adaptation of harness guest/oss_io/client.py.

Keeps its urllib transport, V4 signing, injected configuration/clock/opener,
and typed OSS errors. Adds ListObjectsV2 pagination and conditional GET.
No harness imports, global client, retries, caching, or task/path knowledge.
The caller owns each response stream. urllib keeps no client connection pool
to close. Ambient proxies and redirects are disabled for signed requests.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

DEFAULT_TIMEOUT_SECONDS = 60
DEFAULT_OSS_ENDPOINT = "https://oss-cn-heyuan-internal.aliyuncs.com"
DEFAULT_OSS_REGION = "cn-heyuan"
MAX_LIST_BYTES = 8 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024


class OssError(RuntimeError):
    """OSS rejected a request; retains status, code and diagnostic request ID."""

    def __init__(self, status: int, code: str, message: str,
                 request_id: str | None = None) -> None:
        super().__init__(f"oss {status} {code}: {message}")
        self.status, self.code, self.message = status, code, message
        self.request_id = request_id


class OssNoSuchKey(OssError):
    """A requested object is missing; bucket/access failures stay OssError."""


class OssProtocolError(RuntimeError):
    """An upstream response cannot safely be interpreted."""


class OssObjectTooLarge(ValueError):
    """A response exceeds the caller's byte budget."""


@dataclass(frozen=True)
class NotModified:
    etag: str | None
    last_modified: str | None


@dataclass(frozen=True)
class ObjectInfo:
    key: str
    size: int
    etag: str
    last_modified: str


@dataclass(frozen=True)
class ObjectPage:
    objects: tuple[ObjectInfo, ...]
    prefixes: tuple[str, ...]
    next_cursor: str | None


class ObjectStream:
    """Readable, closeable response with original HTTP metadata.

    ETags retain their quotes. size is None when Content-Length is absent.
    Like harness get_object(), reading is lazy and the caller must close.
    """

    def __init__(self, response: Any) -> None:
        self._response = response
        self.headers = response.headers
        self.etag = self.headers.get("ETag")
        self.last_modified = self.headers.get("Last-Modified")
        self.content_type = self.headers.get("Content-Type")
        declared = self.headers.get("Content-Length")
        try:
            self.size = None if declared is None else int(declared)
            if self.size is not None and self.size < 0:
                raise ValueError
        except (TypeError, ValueError):
            response.close()
            raise OssProtocolError("invalid Content-Length") from None

    def read(self, size: int = -1) -> bytes:
        return self._response.read(size)

    def close(self) -> None:
        self._response.close()

    def __enter__(self) -> ObjectStream:
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()


def _uri_encode(raw: str, *, keep_slash: bool) -> str:
    # Same byte-wise escaping as harness, including UTF-8 and literal '+'.
    out = []
    for byte in raw.encode("utf-8"):
        char = chr(byte)
        keep = (char.isalnum() and byte < 128
                or char in "_-.~" or (keep_slash and char == "/"))
        out.append(char if keep else f"%{byte:02X}")
    return "".join(out)


def _canonical_query(params: dict[str, str]) -> str:
    encoded = sorted(
        (_uri_encode(name, keep_slash=False), _uri_encode(value, keep_slash=False))
        for name, value in params.items()
    )
    return "&".join(name + (f"={value}" if value else "") for name, value in encoded)


def _hmac_sha256(key: bytes, data: str) -> bytes:
    return hmac.new(key, data.encode("utf-8"), hashlib.sha256).digest()


def _parse_list(body: bytes) -> ObjectPage:
    try:
        root = ET.fromstring(body)
        # Handle both namespaced OSS XML and older unnamespaced responses.
        for element in root.iter():
            element.tag = element.tag.rsplit("}", 1)[-1]
        if root.tag != "ListBucketResult":
            raise ValueError
        truncated = root.findtext("IsTruncated")
        if truncated not in ("true", "false"):
            raise ValueError
        encoding = root.findtext("EncodingType")
        if encoding not in (None, "url"):
            raise ValueError

        def decode(value: str) -> str:
            return urllib.parse.unquote(value, errors="strict") if encoding == "url" else value

        def required(element: ET.Element, name: str) -> str:
            value = element.findtext(name)
            if not value:
                raise ValueError
            return value

        objects = []
        for item in root.findall("Contents"):
            size = int(required(item, "Size"))
            if size < 0:
                raise ValueError
            objects.append(ObjectInfo(
                decode(required(item, "Key")), size,
                required(item, "ETag"), required(item, "LastModified"),
            ))
        prefixes = tuple(decode(required(item, "Prefix"))
                         for item in root.findall("CommonPrefixes"))
        cursor = root.findtext("NextContinuationToken")
        if truncated == "true" and not cursor:
            raise ValueError
        if truncated == "false" and cursor:
            raise ValueError
        return ObjectPage(tuple(objects), prefixes, decode(cursor) if cursor else None)
    except (ET.ParseError, ValueError) as exc:
        raise OssProtocolError("invalid ListObjectsV2 response") from exc


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OssClient:
    """One bucket's credentials and read operations; configuration is copied."""

    def __init__(self, credentials: Mapping[str, str], *,
                 clock: Callable[[], float] = time.time,
                 timeout: float = DEFAULT_TIMEOUT_SECONDS,
                 opener: Any = None) -> None:
        fields = ("access_key_id", "access_key_secret", "endpoint", "bucket", "region")
        missing = [field for field in fields if not isinstance(credentials.get(field), str)
                   or not credentials[field]]
        if missing:
            raise ValueError(f"oss_client: credentials missing {', '.join(missing)}")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        self._creds = dict(credentials)
        endpoint = self._creds["endpoint"]
        parsed = urllib.parse.urlsplit(endpoint if "://" in endpoint else "https://" + endpoint)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ValueError("endpoint must be an HTTP(S) OSS endpoint without a path")
        bucket = self._creds["bucket"]
        if any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in bucket):
            raise ValueError("invalid OSS bucket name")
        self._base_url = f"{parsed.scheme}://{bucket}.{parsed.netloc}"
        self._clock, self._timeout = clock, timeout
        self._opener = opener if opener is not None else urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect(),
        )

    def _authorization(self, key: str, query: str, date_iso: str) -> dict[str, str]:
        # Harness V4 signing, with only the GET branch retained.
        headers = {"x-oss-content-sha256": "UNSIGNED-PAYLOAD", "x-oss-date": date_iso}
        canonical_headers = "".join(f"{name}:{headers[name]}\n" for name in sorted(headers))
        canonical_request = "\n".join((
            "GET", _uri_encode(f"/{self._creds['bucket']}/{key}", keep_slash=True),
            query, canonical_headers, "", headers["x-oss-content-sha256"],
        ))
        date, region = date_iso[:8], self._creds["region"]
        scope = f"{date}/{region}/oss/aliyun_v4_request"
        string_to_sign = "\n".join((
            "OSS4-HMAC-SHA256", date_iso, scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ))
        signing_key = _hmac_sha256(
            _hmac_sha256(_hmac_sha256(_hmac_sha256(
                f"aliyun_v4{self._creds['access_key_secret']}".encode(), date,
            ), region), "oss"), "aliyun_v4_request",
        )
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        return {**headers, "Authorization": (
            f"OSS4-HMAC-SHA256 Credential={self._creds['access_key_id']}/{scope}, Signature={signature}"
        )}

    def _open(self, key: str, *, params: dict[str, str] | None = None,
              if_none_match: str | None = None) -> ObjectStream | NotModified:
        query = _canonical_query(params or {})
        date_iso = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(self._clock()))
        headers = self._authorization(key, query, date_iso)
        if if_none_match is not None:
            if not if_none_match or any(c in if_none_match for c in "\r\n"):
                raise ValueError("invalid If-None-Match")
            # Optional standard header; OSS V4 does not require it to be signed.
            headers["If-None-Match"] = if_none_match
        url = f"{self._base_url}/{_uri_encode(key, keep_slash=True)}"
        if query:
            url += f"?{query}"
        request = urllib.request.Request(url, method="GET", headers=headers)
        try:
            response = self._opener.open(request, timeout=self._timeout)
        except urllib.error.HTTPError as exc:
            try:
                if exc.code == 304 and if_none_match is not None:
                    return NotModified(exc.headers.get("ETag"), exc.headers.get("Last-Modified"))
                raise self._error(exc, object_request=bool(key)) from exc
            finally:
                exc.close()
        if response.status != 200:
            response.close()
            raise OssProtocolError("unexpected successful HTTP status")
        return ObjectStream(response)

    @staticmethod
    def _error(exc: urllib.error.HTTPError, *, object_request: bool) -> OssError:
        code = message = ""
        try:
            root = ET.fromstring(exc.read(MAX_ERROR_BYTES))
            for element in root:
                name = element.tag.rsplit("}", 1)[-1]
                if name == "Code":
                    code = element.text or ""
                elif name == "Message":
                    message = element.text or ""
        except (OSError, ET.ParseError):
            pass
        missing = object_request and exc.code == 404 and code in ("", "NoSuchKey")
        error_type = OssNoSuchKey if missing else OssError
        return error_type(exc.code, code or ("NoSuchKey" if missing else str(exc.code)),
                          message or str(exc.reason), exc.headers.get("x-oss-request-id"))

    def get_object(self, key: str, *, if_none_match: str | None = None) -> ObjectStream | NotModified:
        """One GET. Missing objects raise OssNoSuchKey; transport errors propagate."""
        if not isinstance(key, str) or not key:
            raise ValueError("key must be a nonempty string")
        return self._open(key, if_none_match=if_none_match)

    def list_objects(self, prefix: str, *, delimiter: str | None = None,
                     cursor: str | None = None, limit: int = 1000) -> ObjectPage:
        """One ListObjectsV2 page. Feed next_cursor back unchanged to continue."""
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValueError("limit must be an integer from 1 to 1000")
        if not isinstance(prefix, str) or prefix.startswith("/"):
            raise ValueError("prefix must be a string without a leading slash")
        params = {"list-type": "2", "prefix": prefix, "max-keys": str(limit), "encoding-type": "url"}
        for name, value in (("delimiter", delimiter), ("continuation-token", cursor)):
            if value is not None:
                if not isinstance(value, str) or not value:
                    raise ValueError(f"{name} must be a nonempty string")
                params[name] = value
        response = self._open("", params=params)
        with response:
            if response.size is not None and response.size > MAX_LIST_BYTES:
                raise OssObjectTooLarge("ListObjectsV2 response exceeds byte limit")
            body = response.read(MAX_LIST_BYTES + 1)
            if len(body) > MAX_LIST_BYTES:
                raise OssObjectTooLarge("ListObjectsV2 response exceeds byte limit")
        page = _parse_list(body)
        if page.next_cursor is not None and page.next_cursor == cursor:
            raise OssProtocolError("ListObjectsV2 cursor did not advance")
        return page


def env_credentials(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """Harness-compatible OSS_* configuration; never falls back to ALIYUN_*."""
    env = os.environ if environ is None else environ
    return {
        "access_key_id": env.get("OSS_ACCESS_KEY_ID", ""),
        "access_key_secret": env.get("OSS_ACCESS_KEY_SECRET", ""),
        "bucket": env.get("OSS_BUCKET", ""),
        "endpoint": env.get("OSS_ENDPOINT", DEFAULT_OSS_ENDPOINT),
        "region": env.get("OSS_REGION", DEFAULT_OSS_REGION),
    }
