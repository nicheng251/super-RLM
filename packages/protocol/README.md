# super-RLM Protocol

Language-neutral contract for the v0 vertical slice.

## Layout

```text
packages/protocol/
  schemas/
    super-rlm.schema.json   # generated from the Python models
    task.schema.json        # wrapper: TaskView
    ticket.schema.json      # wrapper: TicketResult
    assignment.schema.json  # wrapper: ExecutionRequest
    report.schema.json      # wrapper: WorkerReport
    event.schema.json       # wrapper: Event
    router-api.schema.json  # wrapper: TaskCreateRequest
    worker-api.schema.json  # wrapper: WorkerReport
  python/
    src/super_rlm_protocol/models.py
    scripts/export_schemas.py
    tests/
  ts/
    index.ts
```

## Source of truth

For the v0 slice, the pydantic models under `python/src/super_rlm_protocol/models.py`
are the authoring source. `schemas/super-rlm.schema.json` is generated from them
and is the language-neutral contract consumed by validators and clients.

The JSON Schema adds the report `if`/`then` requirements that pydantic enforces in
`model_validator` methods, so both sides reject `waiting` without a question,
`completed` without a result or artifacts, `failed` without an error, and
`dropped` without a summary.

## Regenerate and verify

```bash
cd packages/protocol/python
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe -e ".[dev]"
.venv/Scripts/python.exe scripts/export_schemas.py
.venv/Scripts/python.exe -m pytest -q

cd ../ts
npm install
npm run check
```

## Scope

Included:

- Task, Ticket, Assignment, Report, Event domain enums and views.
- Router request/response shapes for create, list, status, wait, answer, resume, retry, cancel.
- Worker registration, heartbeat, execution, assignment heartbeat, report, and ack shapes.
- Report-skill payload.

Deferred:

- OpenAPI document generation.
- Generated TypeScript/Python clients from the schema.
- Pagination cursors and event replay semantics beyond the basic shapes.
- HMAC headers and auth scopes (they live at the HTTP layer).
