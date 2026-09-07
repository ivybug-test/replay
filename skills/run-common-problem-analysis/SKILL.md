---
name: run-common-problem-analysis
description: Aggregate completed single-task execution reports from one run into recurring, task-evidenced common problems, then optionally map supported problems to a supplied source-grounded taxonomy.
---

# Run Common-Problem Analysis

Treat the completed single-task reports as the evidence base. Do not replace
them with a new direct review of raw trajectories, and do not infer a problem
from taxonomy labels.

## Analysis order

1. Read every supplied task report summary before forming a run-level finding.
2. Normalize recurring task-specific phenomena into a common problem only when
   the same mechanism appears in at least two distinct tasks. Shared low scores,
   terminal states, applications, or task domains are not mechanisms.
3. For every common problem, identify all supported affected tasks and select
   one to three typical tasks whose task reports contain the clearest evidence.
   Explain the concrete phenomenon in each selected task.
4. Only after the common problem is defined, compare it with the supplied
   taxonomy. Map it only when the task evidence satisfies that node's required
   mechanism and boundaries. Leave the mapping empty when support is weak; do
   not choose the nearest label for presentation completeness.

## Evidence rules

- Preserve the distinction between an observed task phenomenon and a possible
  model, harness, environment, or evaluator cause.
- Do not turn evaluator score or outcome metadata into causal evidence.
- Keep disagreements between task execution and evaluator judgment visible.
- Do not broaden a taxonomy node beyond its source-grounded definition.
- A typical task reference must use an exact task key from the supplied input,
  and its evidence summary must be supported by that task's report.
- Do not report singleton observations as common problems. They remain visible
  in the individual task report and score table.

Use clear, specific Chinese. The caller controls the exact structured-output
schema and report rendering.
