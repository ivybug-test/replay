"""Pure execution summary normalization; publication and execution stay distinct."""
from datetime import datetime
import math
import re
from .oss_io.client import OssProtocolError

TERMINAL = {"succeeded", "failed", "interrupted", "cancelled", "completed", "error"}


def task_id(value):
    if type(value) is int and 0 <= value <= 999:
        return f"{value:03d}"
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,3}", value):
        return value.zfill(3)
    raise OssProtocolError("Invalid task identifier in metadata")


def duration_ms(start, end):
    if not start or not end:
        return None
    try:
        return max(0, int((datetime.fromisoformat(end.replace("Z", "+00:00"))
                           - datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds() * 1000))
    except (TypeError, ValueError, AttributeError):
        return None


def execution_summary(execution, result=None, state=None, public_config=None):
    task = execution.summary
    result, state = result or {}, state or {}
    if result.get("task_id") is not None and task_id(result["task_id"]) != task_id(task.get("task_id")):
        raise OssProtocolError("Result belongs to another task")
    if result.get("batch_id") not in (None, execution.run):
        raise OssProtocolError("Result belongs to another batch")
    evaluation = result.get("evaluation") or {}
    batch_config = execution.batch.get("configuration") or {}
    public_config = public_config or {}
    if (not isinstance(evaluation, dict) or not isinstance(batch_config, dict)
            or not isinstance(public_config, dict)):
        raise OssProtocolError("Invalid result/configuration")
    config = {**batch_config, **public_config}
    # Batch owns execution status; Guest result.status must not prematurely
    # terminate an execution still undergoing Host evaluation.
    status = task.get("status") or result.get("status") or "unknown"
    score = evaluation.get("score") if "score" in evaluation else task.get("score")
    if score is not None and (type(score) not in (float, int) or not math.isfinite(score)):
        raise OssProtocolError("Invalid score")
    started = task.get("started_at") or result.get("started_at") or state.get("started_at")
    finished = task.get("finished_at") or result.get("finished_at") or state.get("finished_at")
    return {
        **task, "key": execution.task, "task_key": execution.task,
        "task_id": task_id(task.get("task_id")), "batch_id": execution.run,
        "batch_name": execution.batch.get("batch_name"),
        "model": task.get("model") or config.get("model") or config.get("model_name"),
        "runtime_name": config.get("runtime_name"),
        "framework": config.get("orchestration"), "status": status,
        "evaluation_status": evaluation.get("status") or task.get("evaluation_status"),
        "agent_outcome": result.get("agent_outcome") or task.get("agent_outcome"),
        "score": score, "started_at": started, "finished_at": finished,
        "duration_ms": duration_ms(started, finished),
        "error": task.get("error") or result.get("harness_error") or result.get("error"),
    }
