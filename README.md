# Gitargo

A management service for Argo Workflows, backed by GitLab. This tool allows you to create, edit, and track the history of Argo Workflow definitions through an web user interface, with all changes automatically synchronized to a GitLab repository.

As optional experimental feature it also has canvas rendering, for visual workflow editing. The project started from https://github.com/omhq/visual-argo-workflows.

## Features

- **GitLab Integration**: Direct synchronization with GitLab. Every save is a commit.
- **Workflow Browser**: List and search all workflow definitions in your repository.
- **Commit History**: View the history of changes for every workflow file directly in the UI.
- **Visual Workflow Editor**: Experimental - Build complex Argo Workflows using a graphical canvas.
- **Docker Ready**: Fully containerized and ready for deployment.

## Architecture

The project consists of two main components:
1.  **Frontend (React)**: A modified version of `visual-argo-workflows` that handles the graphical editing and YAML generation.
2.  **Backend (Node.js/Express)**: A secure proxy that communicates with the GitLab API using a private token, preventing sensitive credentials from being exposed to the browser.

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

## How it Works: Visual State

To maintain the visual layout without requiring a separate database, this tool uses a "State-in-YAML" approach. When you save a workflow:
1. The visual graph is serialized and base64 encoded.
2. This string is injected into the Workflow's `metadata.annotations` under the key `visual-argo-workflows/state`.
3. When you reopen a workflow, the UI reads this annotation to restore the nodes, connections, and canvas position.

## Development

If you want to run the components separately for development:
## Development

### Backend
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

