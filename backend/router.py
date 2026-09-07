"""Thin HTTP dispatch into injected CatalogService and ReplayService."""

from typing import Annotated
import json

from fastapi import APIRouter, Body, Query, Response
from fastapi.responses import JSONResponse

from .catalog import CatalogService
from .oss_io.client import OssObjectTooLarge, OssProtocolError
from .queries import (
    BatchQuery, ExecutionAnalysisRequest, ExecutionQuery, FrameQuery, LiveQuery, MediaQuery,
    LeaderboardQuery, ModelImageQuery, RunsQuery, TaskRunsQuery, WindowQuery, WorkQuery,
    RunAnalysisRequest,
)
from .replay import ReplayService
from .services import ImageContent, ServiceUnavailable

MAX_IMAGE_BYTES = 32 * 1024 * 1024
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_JSON_BYTES = 64 * 1024 * 1024


class BoundedJSONResponse(JSONResponse):
    def render(self, content) -> bytes:
        body = bytearray()
        encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        for part in encoder.iterencode(content):
            encoded = part.encode('utf-8')
            if len(body) + len(encoded) > MAX_JSON_BYTES:
                raise OssObjectTooLarge('JSON exceeds response limit')
            body.extend(encoded)
        return bytes(body)


def _image_response(image: ImageContent) -> Response:
    if image.content_type not in IMAGE_TYPES or not isinstance(image.data, bytes):
        raise OssProtocolError("invalid image content from service")
    if len(image.data) > MAX_IMAGE_BYTES:
        raise OssObjectTooLarge("image exceeds response limit")
    return Response(image.data, media_type=image.content_type,
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


def create_router(catalog: CatalogService | None = None,
                  replay: ReplayService | None = None, analysis=None, cohorts=None) -> APIRouter:
    router = APIRouter(prefix="/api", default_response_class=BoundedJSONResponse)

    def catalog_service() -> CatalogService:
        if catalog is None:
            raise ServiceUnavailable("catalog service is not configured")
        return catalog

    def replay_service() -> ReplayService:
        if replay is None:
            raise ServiceUnavailable("replay service is not configured")
        return replay

    def analysis_service():
        if analysis is None:
            raise ServiceUnavailable("analysis service is not configured")
        return analysis

    def cohort_service():
        if cohorts is None:
            raise ServiceUnavailable("cohort report service is not configured")
        return cohorts

    # Normal def handlers execute in FastAPI's thread pool, keeping later
    # synchronous OSS/SQLite operations off the event loop. Validate queries
    # before resolving the service so bad requests also fail when unwired.
    @router.get("/health", tags=["health"])
    def health():
        return {"status": "ok", "services_configured": {
            "catalog": catalog is not None, "replay": replay is not None,
            "analysis": analysis is not None,
            "cohorts": cohorts is not None,
        }}

    @router.get("/runs", tags=["catalog"])
    def runs(query: Annotated[RunsQuery, Query()]):
        return catalog_service().list_runs(date=query.date)

    @router.get("/leaderboard", tags=["catalog"])
    def leaderboard(query: Annotated[LeaderboardQuery, Query()]):
        return catalog_service().leaderboard(**query.model_dump())

    @router.get("/task-stats", tags=["catalog"])
    def task_stats():
        return catalog_service().task_stats()

    @router.get("/batch", tags=["catalog"])
    def batch(query: Annotated[BatchQuery, Query()]):
        return {"batch": catalog_service().get_batch(run=query.run)}

    @router.get("/task-runs", tags=["catalog"])
    def task_runs(query: Annotated[TaskRunsQuery, Query()]):
        return catalog_service().list_task_runs(**query.model_dump())

    @router.get("/execution-analysis", tags=["analysis"])
    def execution_analysis(query: Annotated[ExecutionQuery, Query()]):
        return analysis_service().state(**query.model_dump())

    @router.get("/analysis-models", tags=["analysis"])
    def analysis_models():
        return analysis_service().models()

    @router.post("/execution-analysis", tags=["analysis"], status_code=202)
    def start_execution_analysis(body: Annotated[ExecutionAnalysisRequest, Body()]):
        return analysis_service().start(**body.model_dump())

    @router.get("/problem-tags", tags=["analysis"])
    def problem_tags():
        return analysis_service().taxonomy()

    @router.get("/run-analysis", tags=["analysis"])
    def run_analysis(query: Annotated[BatchQuery, Query()]):
        return analysis_service().run_state(**query.model_dump())

    @router.post("/run-analysis", tags=["analysis"], status_code=202)
    def start_run_analysis(body: Annotated[RunAnalysisRequest, Body()]):
        return analysis_service().start_run(**body.model_dump())

    @router.get("/run-analysis-statuses", tags=["analysis"])
    def run_analysis_statuses():
        return analysis_service().run_statuses()

    @router.get("/aft-reports", tags=["analysis"])
    def aft_reports():
        return analysis_service().reports()

    @router.get("/aft-reports/{report_id}", tags=["analysis"])
    def aft_report(report_id: str):
        return analysis_service().report(report_id)

    @router.get("/cohort-reports", tags=["analysis"])
    def cohort_reports():
        return cohort_service().list_reports()

    @router.get("/cohort-reports/{report_id}", tags=["analysis"])
    def cohort_report(report_id: str):
        return cohort_service().get(report_id)

    @router.get("/trajectory", tags=["replay"])
    def trajectory(query: Annotated[ExecutionQuery, Query()]):
        return replay_service().get_trajectory(**query.model_dump())

    @router.get("/atif-live", tags=["replay"])
    def atif_live(query: Annotated[LiveQuery, Query()]):
        return replay_service().get_atif_live(**query.model_dump())

    @router.get("/agent-work", tags=["replay"])
    def agent_work(query: Annotated[WorkQuery, Query()]):
        return replay_service().get_agent_work(**query.model_dump())

    @router.get("/window", tags=["replay"])
    def window(query: Annotated[WindowQuery, Query()]):
        return replay_service().get_window(**query.model_dump())

    @router.get("/execution-state", tags=["replay"])
    def execution_state(query: Annotated[ExecutionQuery, Query()]):
        return replay_service().get_execution_state(**query.model_dump())

    image_docs = {200: {"content": {mime: {"schema": {"type": "string", "format": "binary"}}
                                   for mime in sorted(IMAGE_TYPES)}}}

    @router.get("/frame", tags=["media"], response_class=Response, responses=image_docs)
    def frame(query: Annotated[FrameQuery, Query()]):
        return _image_response(replay_service().get_frame(**query.model_dump()))

    @router.get("/model-image", tags=["media"], response_class=Response, responses=image_docs)
    def model_image(query: Annotated[ModelImageQuery, Query()]):
        return _image_response(replay_service().get_model_image(**query.model_dump()))

    @router.get("/atif-media", tags=["media"], response_class=Response, responses=image_docs)
    def atif_media(query: Annotated[MediaQuery, Query()]):
        return _image_response(replay_service().get_atif_media(**query.model_dump()))

    return router
