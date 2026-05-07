require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const YAML = require('yaml');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const GITLAB_BRANCH = process.env.GITLAB_BRANCH || 'main';
const GITLAB_WORKFLOWS_PATH = process.env.GITLAB_WORKFLOWS_PATH || '.';

if (!GITLAB_TOKEN || !GITLAB_PROJECT_ID) {
  console.error('ERROR: GITLAB_TOKEN and GITLAB_PROJECT_ID are required environment variables.');
  process.exit(1);
}

// GitLab API client
const gitlabApi = axios.create({
  baseURL: `${GITLAB_URL}/api/v4`,
  headers: {
    'PRIVATE-TOKEN': GITLAB_TOKEN,
  },
});

app.use(cors());
app.use(express.json());

const BASE_PATH = process.env.BASE_PATH || "";
console.log(`Application BASE_PATH is set to: "${BASE_PATH}"`);

// Helper to serve index.html with injected BASE_PATH config
const serveIndex = (req, res) => {
  const fs = require("fs");
  const indexPath = path.join(__dirname, "public", "index.html");

  fs.readFile(indexPath, "utf8", (err, data) => {
    if (err) {
      return res.status(500).send("Error loading index.html");
    }
    // Inject the BASE_PATH into the head so the SPA can read it
    const injectedData = data.replace(
      "<head>",
      `<head><script>window.BASE_PATH = "${BASE_PATH}";</script>`
    );
    res.send(injectedData);
  });
};

// 1. Serve static files from the public directory
if (BASE_PATH !== "") {
  app.use(
    `${BASE_PATH}/static`,
    express.static(path.join(__dirname, "public", "static"))
  );
}
app.use("/static", express.static(path.join(__dirname, "public", "static")));
app.use(express.static(path.join(__dirname, "public")));

// --- Validation Middleware ---
const allowedArgoKinds = [
  "Workflow",
  "CronWorkflow",
  "WorkflowTemplate",
  "ClusterWorkflowTemplate"
];

const validateArgoWorkflow = (req, res, next) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ message: "Content is required." });
  }

  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return res.status(400).json({ message: "Invalid YAML format." });
    }

    if (!parsed.kind) {
      return res.status(400).json({ message: "Missing 'kind' field in YAML." });
    }

    if (!allowedArgoKinds.includes(parsed.kind)) {
      return res.status(400).json({
        message: `Invalid 'kind'. Only Argo Workflow definitions are allowed. Received: '${parsed.kind}'. Allowed kinds: ${allowedArgoKinds.join(", ")}.`
      });
    }

    next();
  } catch (error) {
    return res
      .status(400)
      .json({ message: `YAML Parsing Error: ${error.message}` });
  }
};

// --- 2. API ROUTES ---

const apiRouter = express.Router();

/**
 * GET /api/workflows
 * List files ending in .yaml, .yml, or .deleted in the GITLAB_WORKFLOWS_PATH.
 */
apiRouter.get("/workflows", async (req, res, next) => {
  try {
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: GITLAB_WORKFLOWS_PATH,
          ref: GITLAB_BRANCH
        }
      }
    );

    const workflows = response.data.filter(
      (file) =>
        file.type === "blob" &&
        (file.name.endsWith(".yaml") || file.name.endsWith(".yml") || file.name.endsWith(".deleted"))
    );

    res.json(workflows);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.json([]);
    }
    next(error);
  }
});

/**
 * GET /api/workflows/:path
 * Get the raw content of a file.
 */
apiRouter.get("/workflows/:path", async (req, res, next) => {
  try {
    const filePath = req.params.path;
    const ref = req.query.ref || GITLAB_BRANCH;

    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
      {
        params: {
          ref: ref
        }
      }
    );

    res.send(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/workflows/:path/history
 * Get the commit history for a file.
 */
apiRouter.get("/workflows/:path/history", async (req, res, next) => {
  try {
    const filePath = req.params.path;
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        params: {
          path: filePath,
          ref: GITLAB_BRANCH
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/workflows/:path
 * Soft-delete a workflow by renaming it with a .deleted extension.
 */
apiRouter.delete("/workflows/:path", async (req, res, next) => {
  try {
    const filePath = req.params.path;
    
    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Delete ${filePath}`,
        actions: [
          {
            action: "move",
            previous_path: filePath,
            file_path: `${filePath}.deleted`
          }
        ]
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/:path/restore
 * Restore a soft-deleted workflow.
 */
apiRouter.post("/workflows/:path/restore", async (req, res, next) => {
  try {
    const filePath = req.params.path;
    const originalPath = filePath.replace(/\.deleted$/, "");

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Restore ${originalPath}`,
        actions: [
          {
            action: "move",
            previous_path: filePath,
            file_path: originalPath
          }
        ]
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/:path
 * Create a new file.
 */
apiRouter.post(
  "/workflows/:path",
  validateArgoWorkflow,
  async (req, res, next) => {
    try {
      let filePath = req.params.path;
      const { content, commit_message } = req.body;

      // Prepend GITLAB_WORKFLOWS_PATH if it's not already in the path and it's not the root
      if (
        GITLAB_WORKFLOWS_PATH !== "." &&
        !filePath.startsWith(GITLAB_WORKFLOWS_PATH)
      ) {
        filePath = `${GITLAB_WORKFLOWS_PATH.replace(/\/$/, "")}/${filePath}`;
      }

      // Inject defaults if configured
      const injectedContent = injectDefaults(content);

      const response = await gitlabApi.post(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(
          filePath
        )}`,
        {
          branch: GITLAB_BRANCH,
          content: injectedContent,
          commit_message: commit_message || `Create ${filePath}`
        }
      );

      res.status(201).json(response.data);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/workflows/:path
 * Update an existing file.
 */
apiRouter.put(
  "/workflows/:path",
  validateArgoWorkflow,
  async (req, res, next) => {
    try {
      const filePath = req.params.path;
      const { content, commit_message } = req.body;

      // Inject defaults if configured
      const injectedContent = injectDefaults(content);

      const response = await gitlabApi.put(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(
          filePath
        )}`,
        {
          branch: GITLAB_BRANCH,
          content: injectedContent,
          commit_message: commit_message || `Update ${filePath}`
        }
      );

      res.json(response.data);
    } catch (error) {
      next(error);
    }
  }
);

// --- Helper for injecting defaults ---
function injectDefaults(content) {
  const ARGO_NAMESPACE = process.env.ARGO_NAMESPACE;
  const ARGO_SERVICE_ACCOUNT = process.env.ARGO_SERVICE_ACCOUNT;
  const ARGO_TOLERATIONS = process.env.ARGO_TOLERATIONS;
  const ARGO_NODE_SELECTOR = process.env.ARGO_NODE_SELECTOR;
  const ARGO_AFFINITY = process.env.ARGO_AFFINITY;

  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") return content;

    if (!parsed.metadata) parsed.metadata = {};
    
    // Ensure metadata.name or generateName is present
    if (!parsed.metadata.name && !parsed.metadata.generateName) {
      parsed.metadata.name = "workflow-default";
    }

    if (ARGO_NAMESPACE && !parsed.metadata.namespace) {
      parsed.metadata.namespace = ARGO_NAMESPACE;
    }

    if (!parsed.spec) parsed.spec = {};
    const isCron = parsed.kind === "CronWorkflow";
    if (isCron && !parsed.spec.workflowSpec) parsed.spec.workflowSpec = {};
    const spec = isCron ? parsed.spec.workflowSpec : parsed.spec;

    if (spec) {
      if (ARGO_SERVICE_ACCOUNT && !spec.serviceAccountName) {
        spec.serviceAccountName = ARGO_SERVICE_ACCOUNT;
      }

      if (ARGO_TOLERATIONS && (!spec.tolerations || spec.tolerations.length === 0)) {
        try {
          spec.tolerations = JSON.parse(ARGO_TOLERATIONS);
        } catch (e) {
          console.error("Failed to parse ARGO_TOLERATIONS", e);
        }
      }

      if (ARGO_NODE_SELECTOR && (!spec.nodeSelector || Object.keys(spec.nodeSelector).length === 0)) {
        try {
          spec.nodeSelector = JSON.parse(ARGO_NODE_SELECTOR);
        } catch (e) {
          console.error("Failed to parse ARGO_NODE_SELECTOR", e);
        }
      }

      if (ARGO_AFFINITY && (!spec.affinity || Object.keys(spec.affinity).length === 0)) {
        try {
          spec.affinity = JSON.parse(ARGO_AFFINITY);
        } catch (e) {
          console.error("Failed to parse ARGO_AFFINITY", e);
        }
      }
    }

    return YAML.stringify(parsed);
  } catch (error) {
    console.error("Error injecting defaults:", error);
    return content;
  }
}


// Resilient API mounting
if (BASE_PATH !== "") {
  app.use(`${BASE_PATH}/api`, apiRouter);
}
app.use("/api", apiRouter);

// --- 3. CATCH-ALL ROUTE ---

// Catch-all route to serve index.html for React Router
if (BASE_PATH !== "") {
  app.get(`${BASE_PATH}/*`, (req, res) => {
    serveIndex(req, res);
  });
}

app.get("*", (req, res) => {
  serveIndex(req, res);
});

// Also handle the root if BASE_PATH is empty or for initial entry
if (BASE_PATH !== "") {
  app.get("/", (req, res) => {
    res.redirect(BASE_PATH);
  });
}


// --- 4. ERROR HANDLING ---

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.response ? err.response.status : 500;
  const message = err.response ? err.response.data : { message: err.message };
  res.status(status).json(message);
});


// --- 5. SERVER START ---

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});