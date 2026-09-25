# worker-pi

Reference adapter boundary for Pi Coding Agent workers.

The package deliberately separates **Pi command construction** from **process management**. `buildPiWorkerProcessSpec()` returns command + argv + cwd + environment without a shell command string. A `WorkerProcessManager` can implement tmux, systemd transient units, containers, Kubernetes jobs, or another durable launcher.

Remote chat workers must use `REMOTE_WORKER_SANDBOX_POLICY`: fail closed when the sandbox is unavailable and never fall back to host read/write/edit/bash tools.

## Resource limits

Every `WorkerBinding` carries `max_runtime_ms` and `max_memory_mb`; `buildPiWorkerProcessSpec()` preserves them in the process specification. A concrete `WorkerProcessManager` must enforce those limits or reject start. The Pi adapter does not silently ignore them.
