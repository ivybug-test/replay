"""ASGI factories: injectable create_app and OSS-wired create_oss_app."""

import http.client
import logging
import urllib.error

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException

from .catalog import CatalogService
from .oss_io.client import OssError, OssNoSuchKey, OssObjectTooLarge, OssProtocolError
from .replay import ReplayService
from .router import create_router
from .services import InvalidQuery, ResourceNotFound, ServiceUnavailable

logger = logging.getLogger(__name__)


class ErrorContent(BaseModel):
    code: str
    message: str
    details: list[dict] | None = None


class ErrorResponse(BaseModel):
    error: ErrorContent


def error_response(status: int, code: str, message: str, **extra) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, **extra}},
                        status_code=status, headers={"Cache-Control": "no-store"})


def create_app(*, catalog: CatalogService | None = None,
               replay: ReplayService | None = None, analysis=None, cohorts=None) -> FastAPI:
    app = FastAPI(title="Replay OSS API", version="0.1.0", debug=False,
                  docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json",
                  redirect_slashes=False, responses={
                      status: {"model": ErrorResponse, "description": description}
                      for status, description in {
                          400: "Invalid query or cursor", 404: "Resource not found",
                          422: "Invalid request parameters", 500: "Internal error",
                          502: "Upstream error", 503: "Service not ready", 504: "Upstream timeout",
                      }.items()
                  })
    app.include_router(create_router(catalog, replay, analysis, cohorts))

    @app.middleware("http")
    async def response_headers(request: Request, call_next):
        try:
            response = await call_next(request)
        except Exception as exc:
            # Handle here so ASGI does not re-raise and log a raw exception
            # containing credentials after sending the sanitized response.
            logger.error("Unhandled API error: %s", type(exc).__name__)
            response = error_response(500, "internal_error", "Internal server error")
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_parameters(request: Request, exc: RequestValidationError):
        # Do not echo arbitrary query values, exception contexts or objects.
        details = [{"location": list(item["loc"]), "type": item["type"]} for item in exc.errors()]
        return error_response(422, "invalid_parameters", "Invalid request parameters", details=details)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        message = {404: "Route not found", 405: "Method not allowed"}.get(exc.status_code, "Request rejected")
        response = error_response(exc.status_code, "http_error", message)
        if exc.headers and "Allow" in exc.headers:
            response.headers["Allow"] = exc.headers["Allow"]
        return response

    async def service_error(request: Request, exc: Exception):
        if isinstance(exc, (ResourceNotFound, OssNoSuchKey)):
            return error_response(404, "not_found", "Execution or artifact not found")
        if isinstance(exc, ServiceUnavailable):
            return error_response(503, "service_unavailable", "Requested service is not ready")
        if isinstance(exc, InvalidQuery):
            return error_response(400, "invalid_query", "Invalid query or cursor")
        if isinstance(exc, TimeoutError) or (
            isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, TimeoutError)
        ):
            return error_response(504, "upstream_timeout", "OSS request timed out")
        if isinstance(exc, OssObjectTooLarge):
            return error_response(502, "artifact_too_large", "Artifact exceeds the read limit")
        if isinstance(exc, OssProtocolError):
            return error_response(502, "invalid_artifact", "Invalid upstream artifact")
        return error_response(502, "upstream_error", "OSS request failed")

    for error_type in (ResourceNotFound, ServiceUnavailable, InvalidQuery, OssError,
                       OssObjectTooLarge, OssProtocolError, urllib.error.URLError,
                       TimeoutError, ConnectionError, http.client.HTTPException):
        app.add_exception_handler(error_type, service_error)

    return app


def create_oss_app(settings=None) -> FastAPI:
    """Wire real OSS services; lifespan owns synchronization and SQLite cleanup."""
    from contextlib import asynccontextmanager
    from starlette.concurrency import run_in_threadpool
    from .artifacts import ArtifactReader
    from .aft_store import AftStore
    from .codex import CodexRunner
    from .cohort_reports import CohortReportStore
    from .native_analysis import ExecutionAnalysisService
    from .cache import ReadCache
    from .config import Settings
    from .execution_index import ExecutionIndex
    from .oss_io.client import OssClient
    from .sync import IndexSynchronizer

    settings = settings or Settings.from_env()
    reader = ArtifactReader(OssClient(settings.credentials, timeout=settings.timeout), settings.prefix,
        cache=ReadCache(max_bytes=settings.read_cache_bytes), live_ttl=settings.live_ttl,
        max_object_bytes=settings.object_bytes, concurrency=settings.read_concurrency)
    index = ExecutionIndex(settings.index_path, namespace=settings.namespace)
    catalog = CatalogService(reader, index)
    replay = ReplayService(reader, cache=ReadCache(max_bytes=settings.replay_cache_bytes, max_entries=16),
                           concurrency=settings.replay_concurrency)
    sync = IndexSynchronizer(catalog, index, interval=settings.sync_interval)
    analysis = ExecutionAnalysisService(
        catalog, replay, AftStore(settings.aft_path),
        CodexRunner(workers=settings.aft_workers),
        workers=settings.aft_workers,
        evaluator_source_root=settings.evaluator_source_root,
    )
    cohorts = CohortReportStore(settings.aft_path)
    app = create_app(catalog=catalog, replay=replay, analysis=analysis, cohorts=cohorts)

    @asynccontextmanager
    async def lifespan(app):
        sync.start()
        try:
            yield
        finally:
            await run_in_threadpool(sync.stop)
            analysis.close()
            cohorts.close()
            index.close()
            reader.cache.clear()
            replay.cache.clear()
            catalog.cache.clear()

    app.router.lifespan_context = lifespan
    app.state.catalog, app.state.replay, app.state.analysis, app.state.cohorts, app.state.sync = (
        catalog, replay, analysis, cohorts, sync,
    )
    return app
