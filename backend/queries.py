"""HTTP query contracts matching Replay's existing fetches."""

from datetime import date as Date
from typing import Annotated

from pydantic import AfterValidator, BaseModel, Field

MAX_CURSOR = 1_000_000
MAX_TIME_MS = 2**53 - 1  # Preserve exact integers in the JS frontend.
Segment = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")]


def _calendar_date(value: str) -> str:
    if Date.fromisoformat(value).isoformat() != value:
        raise ValueError("date must use YYYY-MM-DD")
    return value


def _relative_path(value: str) -> str:
    # Query decoding already occurred. Do not unquote or normalize again:
    # a literal percent sequence may be part of an OSS object name.
    if (value.startswith("/") or "\\" in value or ":" in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError("path must be relative to the execution directory")
    return value


RelativePath = Annotated[str, Field(min_length=1, max_length=1024), AfterValidator(_relative_path)]
Span = Annotated[int, Field(ge=5000, le=120000)]


class RunsQuery(BaseModel):
    date: Annotated[str, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"),
                    AfterValidator(_calendar_date)] | None = None


class BatchQuery(BaseModel):
    run: Segment


class ExecutionQuery(BatchQuery):
    task: Segment


class TaskRunsQuery(BaseModel):
    # Keep the original ID, including leading zeroes. No frontend catalog.
    task_id: Annotated[str, Field(pattern=r"^[0-9]{3}$")]
    cursor: Annotated[str, Field(min_length=1, max_length=2048)] | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 50
    model: Annotated[str, Field(min_length=1, max_length=256)] | None = None
    status: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")] | None = None


class LiveQuery(ExecutionQuery):
    after: Annotated[int, Field(ge=0, le=MAX_CURSOR)] = 0


class WorkQuery(ExecutionQuery):
    center_ms: Annotated[int, Field(ge=-1, le=MAX_TIME_MS)] = -1
    before_ms: Span | None = None
    after_ms: Span | None = None


class WindowQuery(ExecutionQuery):
    center_ms: Annotated[int, Field(ge=-1, le=MAX_TIME_MS)] = -1
    before_ms: Span = 30000
    after_ms: Span = 60000
    include_timeline: bool = True


class FrameQuery(ExecutionQuery):
    frame: Annotated[int, Field(ge=0, le=MAX_TIME_MS)]


class MediaQuery(ExecutionQuery):
    path: RelativePath


class ModelImageQuery(MediaQuery):
    sha256: Annotated[str, Field(pattern=r"^[0-9a-fA-F]{64}$")]
