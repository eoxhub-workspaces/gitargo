# Gitargo

A management service for Argo Workflows, backed by GitLab. This tool allows you to create, edit, and track the history of Argo Workflow definitions through an web user interface, with all changes automatically synchronized to a GitLab repository.

As optional experimental feature it also has canvas rendering, for visual workflow editing. The project started from https://github.com/omhq/visual-argo-workflows.

## Features

- **Workflow Browser**: List and search all workflow definitions in your repository.
- **Workflow Monitoring**: Live tracking of Argo Workflow executions.
- **Log Viewer**: Integrated log viewing via Loki proxy.
- **GitLab Integration**: Direct synchronization with GitLab. Every save is a commit.
- **Commit History**: View the history of changes for every workflow file directly in the UI.
- **Authentication**: Session-based token verification utilizing Kubernetes Service Account tokens or proxy-injected cookies.
- **Visual Workflow Editor**: Experimental - Build complex Argo Workflows using a graphical canvas.
- **Automatic Ingestion**: User-confirmed injection of default K8s properties (tolerations, etc.) during save.
- **Docker Ready**: Fully containerized and ready for deployment.

## Architecture

The project consists of two main components:
1.  **Frontend (React)**: A modified version of `visual-argo-workflows` that handles the graphical editing, monitoring dashboards, and YAML generation.
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
    docker build -t argo-manager .
    ```

2.  **Run the container**:
    ```bash
    docker run -p 3000:3000 \
      -e GITLAB_TOKEN="your_gitlab_token" \
      -e GITLAB_PROJECT_ID="your_project_id" \
      -e GITLAB_URL="https://gitlab.com" \
      -e GITLAB_WORKFLOWS_PATH="workflows" \
      -e LOG_VIEWER_URL="http://logviewer:8080/search" \
      argo-manager
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
| `ARGO_SERVER_URL` | URL of the Argo Server API (e.g. `https://argo-workflows...`). | - |
| `LOG_VIEWER_URL` | Internal or external URL for the Loki Log Viewer API. | `https://hub-otc.eox.at/...` |
| `ARGO_NAMESPACE` | Default namespace for workflows. | `default` |
| `ARGO_TOLERATIONS` | JSON string of default tolerations to ingest on save. | - |

## How it Works: Automatic Ingestion

When saving a workflow, the UI will prompt the user if they want to "ingest defaults". If confirmed, the backend automatically injects infrastructure-specific properties (tolerations, service accounts, node selectors) defined in the environment variables into the YAML before committing to GitLab. This ensures workflows are optimized for the target environment without requiring manual user configuration.

## How it Works: Visual State

To maintain the visual layout without requiring a separate database, this tool uses a "State-in-YAML" approach. When you save a workflow:
1. The visual graph is serialized and base64 encoded.
2. This string is injected into the Workflow's `metadata.annotations` under the key `visual-argo-workflows/state`.
3. When you reopen a workflow, the UI reads this annotation to restore the nodes, connections, and canvas position.

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
  - name: argo-manager
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

## License
