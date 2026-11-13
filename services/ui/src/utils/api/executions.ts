import { api } from "./client";
import {
  WorkflowExecution,
  WorkflowExecutionMetrics,
  CwlSubmissionPayload
} from "./types";

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

export const getExecutionMetrics = async (
  name: string,
  pod?: string
): Promise<WorkflowExecutionMetrics> => {
  const response = await api.get<WorkflowExecutionMetrics>(
    `/executions/${encodeURIComponent(name)}/metrics`,
    { params: { pod } }
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
