import { api } from "./client";
import { Application, ApplicationYamls, ApplicationStatus } from "./types";

export const getApplications = async (): Promise<Application[]> => {
  const response = await api.get<Application[]>("/applications");
  return response.data;
};

export const getApplication = async (name: string): Promise<Application> => {
  const response = await api.get<Application>(
    `/applications/${encodeURIComponent(name)}`
  );
  return response.data;
};

export const createApplication = async (
  name: string,
  yamls: ApplicationYamls,
  commitMessage?: string
): Promise<Application> => {
  const response = await api.post(`/applications/${encodeURIComponent(name)}`, {
    ...yamls,
    commit_message: commitMessage
  });
  return response.data;
};

export const updateApplication = async (
  name: string,
  yamls: ApplicationYamls,
  commitMessage?: string
): Promise<Application> => {
  const response = await api.put(`/applications/${encodeURIComponent(name)}`, {
    ...yamls,
    commit_message: commitMessage
  });
  return response.data;
};

export const deleteApplication = async (
  name: string
): Promise<{ message?: string }> => {
  const response = await api.delete(
    `/applications/${encodeURIComponent(name)}`
  );
  return response.data;
};

export const getApplicationStatus = async (
  name: string
): Promise<ApplicationStatus> => {
  const response = await api.get<ApplicationStatus>(
    `/applications/${encodeURIComponent(name)}/status`
  );
  return response.data;
};

export const deleteApplicationPod = async (
  appName: string,
  podName: string
): Promise<{ message?: string }> => {
  const response = await api.delete(
    `/applications/${encodeURIComponent(appName)}/pods/${encodeURIComponent(
      podName
    )}`
  );
  return response.data;
};
