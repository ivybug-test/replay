"""Shared service return types and exceptions; interfaces live in catalog.py/replay.py.

All methods are synchronous and receive validated values, not HTTP requests.
run is a batch_id; task is a task_key; task_id keeps its leading zeroes.
Replay normalizes storage formats to ATIF in the backend. Agent Work is an
internal intermediate format, exposed only by the transitional legacy method.

Shared failure contract:
- ResourceNotFound: unknown execution or absent requested artifact.
- ServiceUnavailable: dependency/index is not usable yet.
- InvalidQuery: invalid cursor or query semantics.
- OSS transport/protocol/size failures propagate to the HTTP error mapper;
  they must never become an apparently successful empty document/list.

JsonDocument preserves ATIF/harness extension fields. Exact nested schemas,
index cursor encoding and synchronization details live in their own modules.
"""

from dataclasses import dataclass
from typing import Any

JsonDocument = dict[str, Any]


class ResourceNotFound(RuntimeError):
    """The requested execution or artifact does not exist."""


class ServiceUnavailable(RuntimeError):
    """The service is not connected or its index is not yet usable."""


class InvalidQuery(ValueError):
    """A syntactically valid query has invalid service semantics, e.g. a cursor."""


@dataclass(frozen=True)
class ImageContent:
    """Verified image bytes and MIME type, resolved within one execution.

    The service must bound reads and validate image bytes/digests before
    returning. The router additionally enforces its response size/type limit.
    """

    data: bytes
    content_type: str
