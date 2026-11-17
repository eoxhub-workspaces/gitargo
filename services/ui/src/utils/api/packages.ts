import { api } from "./client";
import { PackageFile } from "./types";

export const getPackages = async (): Promise<PackageFile[]> => {
  const response = await api.get<PackageFile[]>("/packages");
  return response.data;
};

export const getPackageRaw = async (path: string): Promise<string> => {
  const response = await api.get<string>(`/packages/${path}`, {
    responseType: "text"
  });
  return response.data;
};

export const savePackage = async (
  path: string,
  content: string,
  commitMessage?: string
): Promise<{ message?: string; path?: string }> => {
  const response = await api.post(`/packages/${path}`, {
    content,
    commit_message: commitMessage
  });
  return response.data;
};

export const deletePackage = async (
  path: string
): Promise<{ message?: string }> => {
  const response = await api.delete(`/packages/${path}`);
  return response.data;
};
