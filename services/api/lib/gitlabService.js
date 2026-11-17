const axios = require('axios');
const https = require('https');

function createGitlabClient() {
  const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com';
  const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
  const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
  const GITLAB_BRANCH = process.env.GITLAB_BRANCH || 'main';

  const gitlabApi = axios.create({
    baseURL: `${GITLAB_URL}/api/v4`,
    headers: {
      'PRIVATE-TOKEN': GITLAB_TOKEN
    },
    httpsAgent: new https.Agent({
      rejectUnauthorized: process.env.GITLAB_INSECURE_TLS === 'true' ? false : false
    })
  });

  return { gitlabApi, GITLAB_PROJECT_ID, GITLAB_BRANCH };
}

module.exports = { createGitlabClient };
