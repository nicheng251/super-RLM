# ADR 0033: Model Registry and `models sync`

Status: accepted  
Date: 2026-11-02

## Context

Pi Agent and Prime Agent have separate model/provider configuration. The project needs one place to manage model aliases, provider credentials, Router model choice, and Worker profiles without touching user globals.

dsh-superagent uses a single global worker model; it has no Model Registry. This is a super-RLM addition driven by named profiles and project isolation.

## Decision

Source files:

```text
config/models.yaml
config/router.yaml
config/profiles.yaml
<SUPER_RLM_HOME>/secrets/providers.env
```

`super-rlm models sync` writes only:

```text
<SUPER_RLM_HOME>/pi/agent/models.json
<SUPER_RLM_HOME>/prime/agent/models.json
```

- Pi uses generated custom provider/model entries and `$ENV` key references.
- Prime uses built-in providers plus environment/auth where possible.
- Prime custom providers that require a literal `apiKey` use a project-local 0600 `models.json`.
- Orchestrator reads only profiles and model aliases; it never reads credentials.
- `models sync --check` validates aliases, provider references, profile references, and file permissions.
- `super-rlm doctor` performs runtime checks.

## Consequences

- One management surface, two runtime configs.
- No secrets in committed files.
- Prime custom-provider secrets live in the project runtime, not the repo.
- A future Model Gateway can replace the generated configs.
- The Router never sees raw credentials.

## Alternatives considered

- Global Pi/Prime config: violates isolation.
- Secrets in committed YAML: unacceptable.
- Model Gateway immediately: more infrastructure than v0 needs.
