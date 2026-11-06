function getUsername(req) {
  if (!req) return null;
  let rawUser = null;
  if (req.user) {
    rawUser = req.user.preferred_username ||
              req.user.nickname ||
              req.user.name ||
              req.user.email ||
              req.user.sub ||
              req.user.username ||
              req.user.upn ||
              req.user.unique_name;
  }
  if (!rawUser && req.headers && typeof req.headers === 'object') {
    rawUser = req.headers['x-authentik-username'] ||
              req.headers['x-preferred-username'] ||
              req.headers['x-user-claim-preferred-username'] ||
              req.headers['x-auth-request-preferred-username'] ||
              req.headers['x-auth-request-user'] ||
              req.headers['x-auth-request-email'] ||
              req.headers['x-forwarded-preferred-username'] ||
              req.headers['x-forwarded-user'] ||
              req.headers['x-forwarded-email'] ||
              req.headers['x-oauth2-proxy-user'] ||
              req.headers['x-oauth2-proxy-email'] ||
              req.headers['x-remote-user'] ||
              req.headers['x-user'] ||
              req.headers['x-username'] ||
              req.headers['remote-user'];
  }
  return rawUser ? String(rawUser).trim() : null;
}

function getCandidateUsernames(req) {
  const usernames = new Set();
  const primary = getUsername(req);
  if (primary) {
    usernames.add(primary);
    usernames.add(primary.toLowerCase());
    if (primary.includes('@')) {
      const shortName = primary.split('@')[0];
      usernames.add(shortName);
      usernames.add(shortName.toLowerCase());
    }
  }

  if (req.user) {
    ['preferred_username', 'nickname', 'name', 'email', 'sub', 'username', 'upn', 'unique_name'].forEach(k => {
      const val = req.user[k];
      if (val && typeof val === 'string') {
        usernames.add(val);
        usernames.add(val.toLowerCase());
        if (val.includes('@')) {
          const s = val.split('@')[0];
          usernames.add(s);
          usernames.add(s.toLowerCase());
        }
      }
    });
  }

  if (req.headers && typeof req.headers === 'object') {
    [
      'x-authentik-username',
      'x-preferred-username',
      'x-user-claim-preferred-username',
      'x-auth-request-preferred-username',
      'x-auth-request-user',
      'x-auth-request-email',
      'x-forwarded-preferred-username',
      'x-forwarded-user',
      'x-forwarded-email',
      'x-oauth2-proxy-user',
      'x-oauth2-proxy-email',
      'x-remote-user',
      'x-user',
      'x-username',
      'remote-user'
    ].forEach(h => {
      const val = req.headers[h];
      if (val && typeof val === 'string') {
        usernames.add(val);
        usernames.add(val.toLowerCase());
        if (val.includes('@')) {
          const s = val.split('@')[0];
          usernames.add(s);
          usernames.add(s.toLowerCase());
        }
      }
    });
  }

  return Array.from(usernames);
}

function getGitLabPath(virtualPath, req = null, envConfig = {}) {
  if (!virtualPath) return "";
  let pathStr = Array.isArray(virtualPath) ? virtualPath.join('/') : String(virtualPath);
  let cleanVirtualPath = pathStr.replace(/^\//, "").replace(/\.\.\//g, "");

  const { GITLAB_WORKFLOWS_PATH, MULTI_TENANT_MODE } = envConfig;
  let basePath = "";
  if (GITLAB_WORKFLOWS_PATH && GITLAB_WORKFLOWS_PATH !== ".") {
    basePath = GITLAB_WORKFLOWS_PATH.replace(/\/$/, "").replace(/^\//, "");
  }

  if (MULTI_TENANT_MODE) {
    const user = getUsername(req);
    if (user) {
      basePath = basePath ? `${basePath}/${user}` : user;
    }
  }

  return basePath ? `${basePath}/${cleanVirtualPath}` : cleanVirtualPath;
}

function getGitLabPackagesPath(virtualPath, req = null, envConfig = {}) {
  if (!virtualPath) return "";
  let pathStr = Array.isArray(virtualPath) ? virtualPath.join('/') : String(virtualPath);
  let cleanVirtualPath = pathStr.replace(/^\//, "").replace(/\.\.\//g, "");

  const { GITLAB_PACKAGES_PATH = 'packages', MULTI_TENANT_MODE } = envConfig;
  let basePath = GITLAB_PACKAGES_PATH.replace(/\/$/, "").replace(/^\//, "");

  if (MULTI_TENANT_MODE) {
    const user = getUsername(req);
    if (user) {
      basePath = `${basePath}/${user}`;
    }
  }

  return `${basePath}/${cleanVirtualPath}`;
}

function getVirtualPath(req, multiTenantMode = false) {
  const raw = req.params[0] || (Array.isArray(req.params.path) ? req.params.path.join('/') : String(req.params.path || ''));
  let virtualPath = raw;
  try {
    virtualPath = decodeURIComponent(raw);
  } catch (e) {
    virtualPath = raw;
  }
  if (multiTenantMode) {
    const username = getUsername(req);
    if (username && !virtualPath.startsWith(`workflows/${username}/`)) {
      virtualPath = `workflows/${username}/${virtualPath.replace(/^workflows\//, '')}`;
    }
  }
  return virtualPath;
}

function parseAppFilename(filename) {
  const match = filename.match(/^(?:(.*)[-._])?(deployment|service|ingress)\.ya?ml$/i);
  if (!match) return null;
  const comp = match[1] ? match[1].trim().toLowerCase() : "";
  const type = match[2].toLowerCase();
  return { comp, type };
}

function resolveAppLocation(appName) {
  if (!appName) return { folder: "", prefix: "" };
  const parts = appName.split('/');
  if (parts.length >= 2) {
    return {
      folder: parts[0],
      prefix: parts.slice(1).join('/')
    };
  }
  return {
    folder: appName,
    prefix: ""
  };
}

function getAppFilename(prefix, type) {
  if (!prefix) return `${type}.yaml`;
  return `${prefix}-${type}.yaml`;
}

module.exports = {
  getUsername,
  getCandidateUsernames,
  getGitLabPath,
  getGitLabPackagesPath,
  getVirtualPath,
  parseAppFilename,
  resolveAppLocation,
  getAppFilename
};
