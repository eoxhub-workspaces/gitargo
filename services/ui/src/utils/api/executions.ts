import { api } from "./client";
import { WorkflowExecution, CwlSubmissionPayload } from "./types";

export const getExecutions = async (): Promise<WorkflowExecution[]> => {
  const response = await api.get<WorkflowExecution[]>("/executions");
  return response.data;
};

export const getExecution = async (
  name: string
): Promise<WorkflowExecution> => {
  const response = await api.get<WorkflowExecution>(
    `/executions/${encodeURIComponent(name)}`
  );
  return response.data;
};

export const deleteExecution = async (name: string): Promise<void> => {
  await api.delete(`/executions/${encodeURIComponent(name)}`);
};

export const terminateExecution = async (name: string): Promise<void> => {
  await api.post(`/executions/${encodeURIComponent(name)}/terminate`);
};

export const submitExecution = async (
  workflow: any
): Promise<WorkflowExecution> => {
  const response = await api.post<WorkflowExecution>("/executions", workflow);
  return response.data;
};

export const submitCwlExecution = async (
  payload: CwlSubmissionPayload
): Promise<WorkflowExecution> => {
  const response = await api.post("/executions/cwl", payload);
  return response.data;
};
