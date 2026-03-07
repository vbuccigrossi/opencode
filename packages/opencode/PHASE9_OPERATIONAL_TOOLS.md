# Phase 9: Operational Tools

**Focus**: Give the agent first-class access to the environment it operates in —
system state, web research, and containers.

## Pillar 38: System Environment

**Problem**: Checking installed packages, runtime versions, ports, disk space, or
environment variables requires ad-hoc bash commands with output parsing.

### Modules
- `src/system/index.ts` — System inspection: packages, runtimes, resources, env, services
- `src/tool/system.ts` — Agent-facing tool with operations

### Operations
- `info`: OS, arch, hostname, kernel, shell, uptime
- `runtimes`: Detect installed runtimes + versions (node, bun, python, go, rust, java, ruby, dotnet)
- `packages`: List or search installed packages (apt, brew, pip, npm global, cargo)
- `install`: Install a package via detected package manager
- `resources`: Disk, memory, CPU usage summary
- `ports`: List listening ports (via ss/lsof)
- `env`: Read environment variables (with secret masking)
- `services`: List running services (systemd/docker)

---

## Pillar 39: Web Research

**Problem**: The existing `webfetch` and `websearch` tools are low-level (fetch a URL,
run a search). Higher-level research tasks need structured results.

### Modules
- `src/research/index.ts` — Research engine: error lookup, docs, changelogs, comparisons
- `src/tool/research.ts` — Agent-facing tool

### Operations
- `error_lookup`: Given an error message/code, search for solutions and return top answers
- `docs`: Fetch documentation for a library (npm, PyPI, crates.io, pkg.go.dev)
- `changelog`: Find what changed between two versions of a package
- `compare`: Compare two libraries/tools for a decision
- `snippet`: Search for code examples of a specific API usage

Note: These build on top of existing webfetch/websearch where available,
but also work standalone using direct HTTP requests.

---

## Pillar 40: Container Operations

**Problem**: Docker is used daily but the agent has no structured interface.
Running `docker ps`, `docker logs`, etc. via bash requires output parsing.

### Modules
- `src/container/index.ts` — Docker API wrapper: ps, logs, exec, build, compose
- `src/tool/container.ts` — Agent-facing tool

### Operations
- `ps`: List running containers with status, ports, names
- `images`: List local images
- `logs`: Get container logs (with tail/since filters)
- `inspect`: Get container details (env, mounts, network, health)
- `exec`: Run a command inside a running container
- `build`: Build an image from a Dockerfile
- `compose_up`: Start services via docker compose
- `compose_down`: Stop services
- `compose_status`: Show status of composed services

---

## Implementation Order

**Batch 1**: System Environment (38) + Container Operations (40) — independent, parallel
**Batch 2**: Web Research (39) — may reference system for runtime detection

## Test Targets
- System: ~20 tests (info parsing, runtime detection, resource parsing)
- Research: ~20 tests (URL building, result formatting, error lookup parsing)
- Container: ~20 tests (output parsing, command building)
- Total: ~60 tests
