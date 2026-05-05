require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

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

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all route to serve index.html for React Router
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * GET /api/workflows
 * List files ending in .yaml or .yml in the GITLAB_WORKFLOWS_PATH.
 */
app.get('/api/workflows', async (req, res, next) => {
  try {
    const response = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/repository/tree`, {
      params: {
        path: GITLAB_WORKFLOWS_PATH,
        ref: GITLAB_BRANCH,
      },
    });

    const workflows = response.data.filter(
      (file) => file.type === 'blob' && (file.name.endsWith('.yaml') || file.name.endsWith('.yml'))
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
app.get('/api/workflows/:path', async (req, res, next) => {
  try {
    const filePath = req.params.path;
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
      {
        params: {
          ref: GITLAB_BRANCH,
        },
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
app.get('/api/workflows/:path/history', async (req, res, next) => {
  try {
    const filePath = req.params.path;
    const response = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/repository/commits`, {
      params: {
        path: filePath,
        ref: GITLAB_BRANCH,
      },
    });

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/:path
 * Create a new file.
 */
app.post('/api/workflows/:path', async (req, res, next) => {
  try {
    const filePath = req.params.path;
    const { content, commit_message } = req.body;

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}`,
      {
        branch: GITLAB_BRANCH,
        content: content,
        commit_message: commit_message || `Create ${filePath}`,
      }
    );

    res.status(201).json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/workflows/:path
 * Update an existing file.
 */
app.put('/api/workflows/:path', async (req, res, next) => {
  try {
    const filePath = req.params.path;
    const { content, commit_message } = req.body;

    const response = await gitlabApi.put(
      `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}`,
      {
        branch: GITLAB_BRANCH,
        content: content,
        commit_message: commit_message || `Update ${filePath}`,
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.response ? err.response.status : 500;
  const message = err.response ? err.response.data : { message: err.message };
  res.status(status).json(message);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
