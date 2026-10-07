# Gitargo

A management service for Argo Workflows, backed by GitLab. This tool allows you to create, edit, and track the history of Argo Workflow definitions through an web user interface, with all changes automatically synchronized to a GitLab repository.

As optional experimental feature it also has canvas rendering, for visual workflow editing. The project started from https://github.com/omhq/visual-argo-workflows.

## Features

- **Workflow Browser**: List and search all workflow definitions in your repository.
- **Application Deployment Management**: Create, edit, and manage microservices (Deployments, Services, and Ingresses) directly via Git commits with strict workspace security.
- **Workflow Monitoring**: Live tracking of Argo Workflow executions.
- **Resources Dashboard**: Monitor chronological CPU (core-minutes), memory, storage, and GPU consumption per workflow run with high-precision tooltip formatting.
- **Log Viewer**: Integrated log viewing via Loki proxy.
- **GitLab Integration**: Direct synchronization with GitLab. Every save is a commit.
- **Commit History**: View the history of changes for every workflow file directly in the UI.
- **Authentication**: Session-based token verification utilizing Kubernetes Service Account tokens or proxy-injected cookies.
- **Scheduling & Resources Panel**: Easily configure default CPU/Memory requests, limits, taints constraints, and service accounts directly in the UI.
- **Proactive Validation Guard**: Real-time warnings during saving if a workflow is missing its service account or has unsupported scheduling configurations.
- **Docker Ready**: Fully containerized and ready for deployment.

## Architecture

The project consists of two main components:
1.  **Frontend (React)**: A robust, simplified Code Editor that handles text editing, live validation checks, monitoring dashboards, and YAML generation.
2.  **Backend (Node.js/Express)**: A proxy that communicates with the GitLab API and Kubernetes API. It handles token extraction for authentication and attributes commits to the authenticated user.

## Monitoring & Tracking

GitArgo provides two ways to track workflow executions:
1.  **Kubernetes API (Primary)**: If Kubernetes credentials are provided, GitArgo fetches live workflow status, node trees, and pod information directly from the cluster.
2.  **Loki Fallback**: If Kubernetes access is unavailable, GitArgo automatically falls back to querying the configured Log Viewer (Loki) for workflow labels. This allows monitoring historical and active executions even without direct cluster access.

## Getting Started

### Prerequisites
- A GitLab Project (Repository) to store your workflows.
- A GitLab Personal Access Token with `api` or `write_repository` scope.

### Running with Docker

The easiest way to run the service is using Docker.

1.  **Build the image**:
    ```bash
    docker build -t gitargo .
    ```

2.  **Run the container**:
    ```bash
    docker run -p 3000:3000 \
      -e GITLAB_TOKEN="your_gitlab_token" \
      -e GITLAB_PROJECT_ID="your_project_id" \
      -e GITLAB_URL="https://gitlab.com" \
      -e GITLAB_WORKFLOWS_PATH="workflows" \
      -e LOG_VIEWER_URL="http://logviewer:8080/search" \
      gitargo
    ```

### Configuration (Environment Variables)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `GITLAB_TOKEN` | **Required**. Your GitLab Personal Access Token. | - |
| `GITLAB_PROJECT_ID` | **Required**. The numeric ID of your GitLab project. | - |
| `GITLAB_URL` | The base URL of your GitLab instance. | `https://gitlab.com` |
| `GITLAB_BRANCH` | The branch where workflows are stored. | `main` |
| `GITLAB_WORKFLOWS_PATH` | The subdirectory in the repo containing `.yaml` files. | `.` (Root) |
| `PORT` | The port the service runs on inside the container. | `3000` |
| `LOG_VIEWER_URL` | Internal or external URL for the Loki Log Viewer API. | `https://hub-otc.eox.at/...` |
| `LOKI_URL` | Internal URL for the Loki API. | `http://loki:3100` |
| `LOKI_NAMESPACE_LABEL` | Label key for namespace in Loki. | `namespace` |
| `ARGO_WORKFLOW_LABEL` | Label key for workflow name in Loki. | `workflows_argoproj_io_workflow` |
| `ARGO_NAMESPACE` | Default namespace for workflows. | `default` |
| `ARGO_SERVICE_ACCOUNT` | Recommended default service account to check and set. | `default` |
| `ARGO_AVAILABLE_TOLERATIONS` | JSON string of cluster-supported tolerations for the form dropdowns. | - |
| `ARGO_AVAILABLE_NODE_SELECTORS` | JSON string of cluster-supported node selectors (only renders if configured). | - |
| `ARGO_PROFILES` | JSON string of default presets available during new file template creation. | - |
| `ENABLE_APPLICATIONS` | Enable the experimental Application Deployment Management tab. | `false` |
| `GITLAB_APPLICATIONS_PATH` | The subdirectory in the repo containing application folders. | `applications` |
| `ALLOW_PUBLIC_INGRESS` | Allow creating/editing `ingress.yaml` to expose applications publicly. | `false` |

## How it Works: Proactive Configuration Guard

When saving a workflow template, the frontend automatically audits the YAML code. If it detects that the service account is missing, or that the file contains node taints/selectors that are not officially supported on the cluster, it pops up a non-intrusive **Configuration Warning** alert:
* **Review Configuration:** Opens the interactive **Scheduling & Resources** panel where users can see plain-text explanations of what resources/tolerations are, click single-action buttons to apply defaults/clear unsupported keys, or check step-level copy-pasteable YAML examples.
* **Save Anyway:** Bypasses the warning. Users can also select "Do not warn me again" which automatically writes an ignore annotation to the YAML (`gitargo.eox.at/ignore-warnings`) to keep all subsequent saves silent.

## Development

If you want to run the components separately for development:

### Rapid Deployment Script

For testing changes rapidly in a Kubernetes environment without a full image rebuild, a helper script is provided:

```bash
# Push current backend/frontend code directly to the running pod and restart the server
./push.sh <namespace>
```

**Note for Hot-Reloading:**
To ensure the server picks up backend changes without the container being wiped (which happens on a full container restart), your development pod should be running with a shell loop. You can achieve this by adding a `command` override to your Kubernetes deployment manifest:

```yaml
spec:
  containers:
  - name: gitargo
    # ...
    command: ["sh", "-c", "while true; do node server.js; sleep 1; done"]
```

If you only change UI files in `services/ui/src`, no restart is needed; the changes will be visible as soon as the script finishes copying.
```bash
cd services/api
npm install
# Create a .env file based on .env.example
npm start
```

### Frontend
```bash
cd services/ui
npm install
npm start
```

### Linting & Formatting

The project has strict linting and formatting rules enforced during the Docker build. You can run these commands locally to fix issues:

```bash
# Navigate to UI directory
cd services/ui

# Run Prettier to fix formatting
npm run prettier-format

# Run ESLint to find issues
npm run lint

# Run ESLint and automatically fix fixable issues
npm run lint:fix
```

### Version Bumping

To maintain consistency across the project, the version number is synchronized across three configuration files:
1. Root `package.json`
2. Backend `services/api/package.json`
3. Frontend `services/ui/package.json`

The most robust way to bump the version and generate standard Git release tags is:

#### Standard Automated Bump:
You can use standard npm version commands at the root of the project to bump all three files and tag your git repository in a single action:
```bash
# Bumps patch version (e.g. 0.3.0 -> 0.3.1) and creates a git tag
npm version patch

# Bumps minor version (e.g. 0.3.0 -> 0.4.0) and creates a git tag
npm version minor
```

#### Manual Sync (Alternative):
If you need to manually change the version, update the `"version"` field in all three `package.json` files to match exactly, then run the installs to synchronize the lockfiles:
```bash
# Sync root and subdirectory lockfiles
npm install --no-audit
cd services/api && npm install --no-audit
cd ../ui && npm install --no-audit
```

## Container Security (DevSecOps)

This project strictly adheres to secure, enterprise-grade container standards:
* **Minimal Base Images**: Uses `node:20-alpine` to minimize package surface area and CVE vulnerabilities.
* **Non-Root Execution**: Runs strictly as an unprivileged, custom user (`gitargo`, UID `10001`). Root container configurations are rejected by cluster security policies.
* **No unnecessary files**: A `.dockerignore` policy is implemented in the repository to guarantee that local configuration are not added the context build or the published image.
* **Local Scanning (Trivy)**: Image builds should be audited locally using Trivy before release:
  ```bash
  docker build --no-cache -t gitargo:local .
  trivy image --severity HIGH,CRITICAL gitargo:local
  ```
* **Image Signing (Cosign)**: Container images are automatically signed inside the CI pipeline (`build-and-push.yaml`) using cryptographic keyless OIDC Cosign signing (`sigstore`).

### Automated Tag-Based Build Target Selection (CI Pipeline)

The GitHub Actions workflow (`build-and-push.yaml`) automatically inspects the pushed git tag name to optimize the container layout:
* **Development Tags (tags containing `-dev`, e.g. `v0.2.1-dev`)**: Builds targeting the `development` stage in the `Dockerfile`.
  * **Result**: Keeps `npm`, `npx`, and development tools fully active and pre-loaded. Perfect for rapid developer loops and hot-reload tasks.
* **Production Tags (standard tags, e.g. `v0.2.1`)**: Builds targeting the hardened `production` stage in the `Dockerfile`.
  * **Result**: Permanently purges `npm` and `npx` directories, runs as unprivileged user `gitargo`, and passes Trivy audits with **0 vulnerabilities**.

### Clean Container Rebuilds (Patching CVEs)

If security scanners (like `Trivy`) report high or critical vulnerabilities in Alpine system libraries (such as OpenSSL `libcrypto3` or `libssl3` packages), you can resolve them instantly without modifying any source code.

Because the `Dockerfile` is built with dynamic security upgrades (`RUN apk update && apk upgrade --no-cache`), simply run a **cache-free container rebuild** to pull down the latest patched OS library packages:

```bash
# Build the image from scratch, downloading the newest Alpine security updates
docker build --no-cache -t gitargo:local .
```

## License
