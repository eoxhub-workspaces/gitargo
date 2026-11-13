import { api } from "./client";
import { WorkflowFile, CommitHistory } from "./types";

export const getWorkflows = async (): Promise<WorkflowFile[]> => {
  const response = await api.get<WorkflowFile[]>("/workflows");
  return response.data;
};

export const getWorkflow = async (
  path: string,
  commitId?: string
): Promise<WorkflowFile> => {
  const response = await api.get(`/workflows/${encodeURIComponent(path)}`, {
    params: { commit_id: commitId },
    responseType: "text"
  });
  const rawContent =
    typeof response.data === "string"
      ? response.data
      : JSON.stringify(response.data, null, 2);

  return {
    id: path,
    name: path.split("/").pop() || path,
    type: "blob",
    path: path,
    mode: "100644",
    content: rawContent
  };
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
): Promise<WorkflowFile> => {
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
): Promise<WorkflowFile> => {
  const response = await api.put(`/workflows/${encodeURIComponent(path)}`, {
    content,
    commit_message: commitMessage,
    applyDefaults
  });
  return response.data;
};

export const deleteWorkflow = async (
  path: string
): Promise<{ message?: string }> => {
  const response = await api.delete(`/workflows/${encodeURIComponent(path)}`);
  return response.data;
};

export const restoreWorkflow = async (
  path: string
): Promise<{ message?: string }> => {
  const response = await api.post(
    `/workflows/${encodeURIComponent(path)}/restore`
  );
  return response.data;
};

export const getPublishedWorkflows = async (): Promise<string[]> => {
  const response = await api.get<string[]>("/published-workflows");
  return response.data;
};

export const publishWorkflow = async (
  path: string
): Promise<{ message?: string; success?: boolean }> => {
  const response = await api.post(
    `/workflows/${encodeURIComponent(path)}/publish`
  );
  return response.data;
};

export const unpublishWorkflow = async (
  path: string
): Promise<{ message?: string; success?: boolean }> => {
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
