---
name: single-task-execution-analysis
description: Analyze one ongoing, completed, or interrupted agent task from task context, trajectory, call relationships, artifacts, and evaluator evidence; produce an execution-focused report without taxonomy mapping or analyzer-process narration.
---

# Single-Task Execution Analysis

Explain what the observed Agent actually did and how well the work progressed. Use the available read-only evidence tools as needed and choose your own investigation order.

## Report focus

Make the execution understandable without requiring the reader to inspect the raw trajectory:

- Lead with a direct conclusion covering the approach, achieved work, completion level, current state, and overall execution quality.
- Describe major issues only as observable task-specific phenomena. Connect every issue to the relevant Turn IDs and state its practical impact. Do not map issues to a taxonomy or force a model, harness, environment, or grader root-cause judgment.
- Explain Agent and sub-Agent calls in terms of assignments, returned work, and how upstream Agents used the results. Keep a single-Agent relationship summary brief.
- Group the trajectory into meaningful execution phases. State what each phase tried to accomplish, what happened, and whether it completed.
- Describe every Agent Turn semantically: its purpose, concrete action, result, effect on task progress, and an execution assessment. Combine the message, reasoning, tool arguments, tool results, surrounding Turns, and artifacts when useful. Avoid descriptions that merely restate a tool category such as “read a file” or “ran a command.”
- Analyze the evaluator after explaining execution. State what it checked, how it scored the result, and whether its judgment differs from what the trajectory establishes.

Treat `status`, `agent_outcome`, `evaluation_status`, and score as evidence, not as substitutes for trajectory analysis. Do not foreground an outcome label unless the execution is stuck, abnormally interrupted, or the terminal state materially affects task progress.

For an ongoing execution, analyze the published trajectory as a point-in-time snapshot. State the current progress and unresolved work without treating absent future Turns as a failure. If evaluator results are not available yet, say so and complete the rest of the report normally.

Do not include praise sections, generic recommendations, research citations, taxonomy labels, or descriptions of your own tool use, constraints, evidence-gathering workflow, or report-generation process.

Use only Agent, Turn, call, artifact, and evaluator facts supported by tool results. Express uncertainty directly when evidence is incomplete.
