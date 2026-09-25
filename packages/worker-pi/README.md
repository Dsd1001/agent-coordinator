# worker-pi

Reference adapter boundary for Pi Coding Agent workers.

The package deliberately separates **Pi command construction** from **process management**. `buildPiWorkerProcessSpec()` returns command + argv + cwd + environment without a shell command string. A `WorkerProcessManager` can implement tmux, systemd transient units, containers, Kubernetes jobs, or another durable launcher.

Remote chat workers must use `REMOTE_WORKER_SANDBOX_POLICY`: fail closed when the sandbox is unavailable and never fall back to host read/write/edit/bash tools.
