"""Thin HTTP dispatch into injected CatalogService and ReplayService."""

from typing import Annotated
import json

from fastapi import APIRouter, Query, Response
from fastapi.responses import JSONResponse

from .catalog import CatalogService
from .oss_io.client import OssObjectTooLarge, OssProtocolError
from .queries import (
    BatchQuery, ExecutionQuery, FrameQuery, LiveQuery, MediaQuery,
    ModelImageQuery, RunsQuery, TaskRunsQuery, WindowQuery, WorkQuery,
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
                  replay: ReplayService | None = None) -> APIRouter:
    router = APIRouter(prefix="/api", default_response_class=BoundedJSONResponse)

    def catalog_service() -> CatalogService:
        if catalog is None:
            raise ServiceUnavailable("catalog service is not configured")
        return catalog

    def replay_service() -> ReplayService:
        if replay is None:
            raise ServiceUnavailable("replay service is not configured")
        return replay

    # Normal def handlers execute in FastAPI's thread pool, keeping later
    # synchronous OSS/SQLite operations off the event loop. Validate queries
    # before resolving the service so bad requests also fail when unwired.
    @router.get("/health", tags=["health"])
    def health():
        return {"status": "ok", "services_configured": {
            "catalog": catalog is not None, "replay": replay is not None,
        }}

    @router.get("/runs", tags=["catalog"])
    def runs(query: Annotated[RunsQuery, Query()]):
        return catalog_service().list_runs(date=query.date)

    @router.get("/batch", tags=["catalog"])
    def batch(query: Annotated[BatchQuery, Query()]):
        return {"batch": catalog_service().get_batch(run=query.run)}

    @router.get("/task-runs", tags=["catalog"])
    def task_runs(query: Annotated[TaskRunsQuery, Query()]):
        return catalog_service().list_task_runs(**query.model_dump())

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
