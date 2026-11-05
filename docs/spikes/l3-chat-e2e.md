# L3 Chat live E2E

Status: passed  
Date: 2026-11-05  
Run: `20261105T094728Z_2196`

## What was tested

The L3 Chat backend: Pi RPC with the `super-rlm` Router extension, Orchestrator,
Worker, real DeepSeek, profile routing, artifact reporting, and delivery back to
the launch directory.

- Orchestrator: `127.0.0.1:18841`
- Worker: `127.0.0.1:18099`
- Provider/model: `deepseek/deepseek-flash`
- Router profile: `default`

## Result

```text
Task:   tsk_3ad4882b3493458ab949
Ticket: tkt_30d937f4f70342b18321
Task:   succeeded
Ticket: succeeded
```

Chat turn:

```text
prompt seen:        true
turn settled:       true
tools used:         task_create
task_wait used:     false
extension errors:   none
```

Ticket:

```text
profile:            default
summary:            wrote hello.txt
result:             hello.txt created
artifacts:          hello.txt
delivery_error:     null
delivered_to:       <log-dir>/origin/hello.txt
```

Delivered file:

```text
hello from l3 chat
```

## Reproduce

Stop any Orchestrator using the same home, or use a disposable home:

```bash
cd C:/Users/15065/Project/super-RLM
python scripts/regression/l3_chat.py \
  --home <disposable-home> \
  --kernel-venv C:/Users/15065/.super-rlm/projects/prj_deepseek/prime/kernel-venv
```

This is a manual, paid check. It is not part of the unit suites.
