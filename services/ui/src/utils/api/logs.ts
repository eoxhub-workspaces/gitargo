import { api } from "./client";
import { AppConfig, GetLogsOptions } from "./types";

export const getLogs = async (
  id: string,
  options: GetLogsOptions | "pod" | "workflow" | "overview" = {}
): Promise<string> => {
  const opts: GetLogsOptions =
    typeof options === "string" ? { type: options } : options;
  const { type = "pod", query, startTime, endTime, workflow } = opts;
  const response = await api.get(`/logs/${id}`, {
    params: { type, query, start_time: startTime, end_time: endTime, workflow }
  });
  return response.data;
};

export const getConfig = async (): Promise<AppConfig> => {
  const response = await api.get<AppConfig>("/config");
  return response.data;
};
