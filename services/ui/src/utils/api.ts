import axios from "axios";

const api = axios.create();

// Use an interceptor to set the baseURL dynamically at request time.
// This ensures that window.BASE_PATH (which is calculated and set in index.tsx)
// is available when the request is actually made, overcoming module load order issues.
api.interceptors.request.use((config) => {
  const isDev = process.env.NODE_ENV === "development";
  const basePath = window.BASE_PATH || "";

  config.baseURL = isDev ? "http://localhost:3000/api" : `${basePath}/api`;
  return config;
});

export interface WorkflowFile {
  id: string;
  name: string;
  type: string;
  path: string;
  mode: string;
}

export interface CommitHistory {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  author_email: string;
  authored_date: string;
  committer_name: string;
  committer_email: string;
  committed_date: string;
  message: string;
}

export const getWorkflows = async (): Promise<WorkflowFile[]> => {
  const response = await api.get<WorkflowFile[]>("/workflows");
  return response.data;
};

export const getWorkflow = async (
  path: string,
  ref?: string
): Promise<string> => {
  const response = await api.get(`/workflows/${encodeURIComponent(path)}`, {
    params: ref ? { ref } : undefined
  });
  return response.data;
};

export const getWorkflowHistory = async (
  path: string
): Promise<CommitHistory[]> => {
  const response = await api.get<CommitHistory[]>(
    `/workflows/${encodeURIComponent(path)}/history`
  );
  return response.data;
};

export const createWorkflow = async (
  path: string,
  content: string,
  commitMessage?: string
) => {
  const response = await api.post(`/workflows/${encodeURIComponent(path)}`, {
    content,
    commit_message: commitMessage
  });
  return response.data;
};

export const updateWorkflow = async (
  path: string,
  content: string,
  commitMessage?: string
) => {
  const response = await api.put(`/workflows/${encodeURIComponent(path)}`, {
    content,
    commit_message: commitMessage
  });
  return response.data;
};

export const deleteWorkflow = async (path: string) => {
  const response = await api.delete(`/workflows/${encodeURIComponent(path)}`);
  return response.data;
};

export const restoreWorkflow = async (path: string) => {
  const response = await api.post(
    `/workflows/${encodeURIComponent(path)}/restore`
  );
  return response.data;
};

export default api;
