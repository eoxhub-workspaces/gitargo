import { api } from "./client";
import { WorkspaceFilesResponse } from "./types";

declare const process: { env: Record<string, string | undefined> };

export const getWorkspaceFiles = async (
  filePath: string = ""
): Promise<WorkspaceFilesResponse> => {
  const response = await api.get<WorkspaceFilesResponse>("/workspace/files", {
    params: { path: filePath }
  });
  return response.data;
};

export const getWorkspaceFileDownloadUrl = (filePath: string): string => {
  const isDev = process.env.NODE_ENV === "development";
  const basePath = window.BASE_PATH || "";
  const apiBase = isDev ? "http://localhost:3000/api" : `${basePath}/api`;
  return `${apiBase}/workspace/files/download?path=${encodeURIComponent(
    filePath
  )}`;
};
