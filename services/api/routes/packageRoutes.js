const express = require('express');
const path = require('path');

function createPackageRouter(ctx) {
  const router = express.Router();

  const {
    gitlabApi,
    GITLAB_PROJECT_ID,
    GITLAB_BRANCH,
    GITLAB_WORKFLOWS_PATH,
    GITLAB_PACKAGES_PATH,
    GITLAB_APPLICATIONS_PATH,
    ENABLE_WORKFLOWS,
    ENABLE_OGC_PACKAGES,
    ENABLE_APPLICATIONS,
    ALLOW_PUBLIC_INGRESS,
    MULTI_TENANT_MODE,
    JUPYTERHUB_PVC_NAME,
    JUPYTER_PVC_MOUNT_PATH,
    INGRESS_DEFAULTS,
    ingressClusterConfig,
    ARGO_PROFILES,
    EPHEMERAL_VOLUME_CONFIG,
    BASE_PATH,
    customObjectsApi,
    appsV1Api,
    coreV1Api,
    networkingV1Api,
    k8sApi,
    k8sCustomApi,
    k8sCoreApi,
    kc,
    getUsername,
    getCandidateUsernames,
    getGitLabPath,
    getGitLabPackagesPath,
    getVirtualPath,
    parseAppFilename,
    resolveAppLocation,
    getAppFilename,
    getCommitOptions,
    stripAnsiCodes,
    hasWorkspaceGroupAccess,
    requiresAuth,
    requiresApplicationsEnabled,
    resolveSafeWorkspacePath,
    listWorkspaceDirectory,
    validateArgoWorkflow
  } = ctx;

router.get("/packages", async (req, res, next) => {
  try {
    let searchPath = GITLAB_PACKAGES_PATH;
    if (MULTI_TENANT_MODE) {
      const user = getUsername(req);
      if (user) {
        searchPath = `${searchPath.replace(/\/$/, "")}/${user}`;
      }
    }

    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: searchPath,
          ref: GITLAB_BRANCH,
          recursive: true
        }
      }
    );

    const prefix = `${searchPath.replace(/\/$/, "")}/`;

    const packages = response.data
      .filter(
        (file) =>
          file.type === "blob" &&
          (file.name.endsWith(".cwl") || file.name.endsWith(".yaml") || file.name.endsWith(".yml"))
      )
      .map((file) => {
        let relativePath = file.path;
        if (prefix && relativePath.startsWith(prefix)) {
          relativePath = relativePath.slice(prefix.length);
        }
        return { ...file, path: relativePath };
      });

    res.json(packages);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.json([]);
    }
    next(error);
  }
});

/**
 * GET /api/packages/*
 * Get raw package content
 */
router.get(/^\/packages\/(.+)$/, async (req, res, next) => {
  if (req.path === '/packages/' || req.path === '/packages') return next();

  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPackagesPath(virtualPath, req);
    const ref = req.query.ref || GITLAB_BRANCH;

    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
      {
        params: { ref },
        responseType: 'text'
      }
    );

    res.setHeader('Content-Type', 'text/plain');
    res.send(response.data);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ message: "Package file not found in repository." });
    }
    next(error);
  }
});

/**
 * POST /api/packages/*
 * Create or update a package file in GitLab
 */
router.post(/^\/packages\/(.+)$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPackagesPath(virtualPath, req);
    const { content, commit_message } = req.body;

    if (!content) {
      return res.status(400).json({ message: "Content is required." });
    }

    let action = 'create';
    try {
      await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}`,
        { params: { ref: GITLAB_BRANCH } }
      );
      action = 'update';
    } catch (err) {
      if (err.response && err.response.status === 404) {
        action = 'create';
      } else {
        throw err;
      }
    }

    const commitMsg = commit_message || `${action === 'create' ? 'Add' : 'Update'} package ${virtualPath}`;

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: commitMsg,
        actions: [
          {
            action: action,
            file_path: filePath,
            content: content
          }
        ]
      }
    );

    res.json({ message: `Package ${virtualPath} saved successfully.`, commit: response.data });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/packages/*
 * Delete a package file in GitLab
 */
router.delete(/^\/packages\/(.+)$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPackagesPath(virtualPath, req);

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Delete package ${virtualPath}`,
        actions: [
          {
            action: 'delete',
            file_path: filePath
          }
        ]
      }
    );

    res.json({ message: `Package ${virtualPath} deleted successfully.` });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/executions/cwl
 * Submit a CWL execution by wrapping it in an Argo Workflow using cwltool
 */

  return router;
}

module.exports = { createPackageRouter };
