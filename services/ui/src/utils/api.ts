import axios from "axios";

const api = axios.create({
  withCredentials: true
});

// Use an interceptor to set the baseURL dynamically at request time.
// This ensures that window.BASE_PATH (which is calculated and set in index.tsx)
// is available when the request is actually made, overcoming module load order issues.
api.interceptors.request.use((config) => {
  const isDev = process.env.NODE_ENV === "development";
  const basePath = window.BASE_PATH || "";

  config.baseURL = isDev ? "http://localhost:3000/api" : `${basePath}/api`;
  return config;
});

// Response interceptor to handle authentication redirects
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // If the backend returns 401 Unauthorized, it means the OIDC session is expired or missing.
    if (error.response && error.response.status === 401) {
      // Avoid infinite loop if we are already at the login endpoint
      if (window.location.pathname.endsWith("/login")) {
        return Promise.reject(error);
      }

      const isDev = process.env.NODE_ENV === "development";
      const basePath = window.BASE_PATH || "";

      // In local development, the React dev server (usually 3001) and backend (3000)
      // run on different ports. We must redirect to the backend port specifically.
      if (isDev) {
        window.location.href = "http://localhost:3000/login";
      } else {
        // Ensure absolute path by starting with /
        const loginUrl = `${basePath}/login`.replace(/\/+/g, "/");
        window.location.href = loginUrl.startsWith("/")
          ? loginUrl
          : `/${loginUrl}`;
      }
    }
    return Promise.reject(error);
  }
);

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

export interface AppConfig {
  profiles: Record<
    string,
    {
      label: string;
      resources: any;
      tolerations?: any[];
    }
  >;
  ephemeralVolume: {
    name: string;
    storage: string;
    storageClassName: string;
    mountPath: string;
  };
  defaults: {
    namespace: string;
    serviceAccount: string;
  };
  logViewerUrl?: string;
  allowPublishing: boolean;
  experimentalCanvas: boolean;
}

export interface WorkflowExecution {
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp: string;
    labels?: Record<string, string>;
  };
  status?: {
    phase: string;
    message?: string;
    conditions?: any[];
    startedAt: string;
    finishedAt?: string;
    nodes?: Record<string, any>;
  };
  spec: any;
}

export const getExecutions = async (): Promise<WorkflowExecution[]> => {
  const response = await api.get<WorkflowExecution[]>("/executions");
  return response.data;
};

export const getExecution = async (
  name: string
): Promise<WorkflowExecution> => {
  const response = await api.get<WorkflowExecution>(`/executions/${name}`);
  return response.data;
};

export const deleteExecution = async (name: string): Promise<void> => {
  await api.delete(`/executions/${name}`);
};

export const submitExecution = async (
  workflow: any
): Promise<WorkflowExecution> => {
  const response = await api.post<WorkflowExecution>("/executions", workflow);
  return response.data;
};

export const getLogs = async (
  id: string,
  type: "pod" | "workflow" = "pod",
  query?: string,
  startTime?: string,
  endTime?: string
): Promise<string> => {
  const response = await api.get(`/logs/${id}`, {
    params: { type, query, start_time: startTime, end_time: endTime }
  });
  return response.data;
};

export const getConfig = async (): Promise<AppConfig> => {
  const response = await api.get<AppConfig>("/config");
  return response.data;
};

export const getPublishedWorkflows = async (): Promise<string[]> => {
  const response = await api.get<string[]>("/published-workflows");
  return response.data;
};

export const publishWorkflow = async (path: string) => {
  const response = await api.post(
    `/workflows/${encodeURIComponent(path)}/publish`
  );
  return response.data;
};

export const unpublishWorkflow = async (path: string) => {
  const response = await api.delete(
    `/workflows/${encodeURIComponent(path)}/publish`
  );
  return response.data;
};

export const getSyncStatus = async (
  path: string,
  token: string
): Promise<{ synced: boolean; kind?: string }> => {
  const response = await api.get(
    `/workflows/${encodeURIComponent(path)}/sync-status`,
    {
      params: { token }
    }
  );
  return response.data;
};

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
  commitMessage: string,
  applyDefaults = false
) => {
  const response = await api.post(`/workflows/${encodeURIComponent(path)}`, {
    content,
    commit_message: commitMessage,
    applyDefaults
  });
  return response.data;
};

export const updateWorkflow = async (
  path: string,
  content: string,
  commitMessage: string,
  applyDefaults = false
) => {
  const response = await api.put(`/workflows/${encodeURIComponent(path)}`, {
    content,
    commit_message: commitMessage,
    applyDefaults
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
