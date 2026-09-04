"""Bounded read helper, following harness's file layer with explicit client injection."""

from .client import OssClient, OssObjectTooLarge, OssProtocolError


def read_bytes(client: OssClient, key: str, *, max_bytes: int) -> bytes:
    """Read one object and always close, including overflow and transport failure.

    Uses an unconditional GET. Cache-aware callers use get_object directly
    to retain response metadata and handle NotModified.
    """
    if type(max_bytes) is not int or max_bytes < 0:
        raise ValueError("max_bytes must be a nonnegative integer")
    with client.get_object(key) as response:
        if response.size is not None and response.size > max_bytes:
            raise OssObjectTooLarge(f"object exceeds {max_bytes} bytes")
        data = bytearray()
        while True:
            chunk = response.read(min(64 * 1024, max_bytes + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > max_bytes:
                raise OssObjectTooLarge(f"object exceeds {max_bytes} bytes")
        if response.size is not None and len(data) != response.size:
            raise OssProtocolError("object body does not match Content-Length")
        return bytes(data)
