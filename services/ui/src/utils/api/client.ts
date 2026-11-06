import axios from "axios";

declare const process: { env: Record<string, string | undefined> };

export const api = axios.create({
  withCredentials: true
});

api.interceptors.request.use((config) => {
  const isDev = process.env.NODE_ENV === "development";
  const basePath = window.BASE_PATH || "";

  config.baseURL = isDev ? "http://localhost:3000/api" : `${basePath}/api`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      if (window.location.pathname.endsWith("/login")) {
        return Promise.reject(error);
      }

      const isDev = process.env.NODE_ENV === "development";
      const basePath = window.BASE_PATH || "";

      if (isDev) {
        window.location.href = "http://localhost:3000/login";
      } else {
        const loginUrl = `${basePath}/login`.replace(/\/+/g, "/");
        window.location.href = loginUrl.startsWith("/")
          ? loginUrl
          : `/${loginUrl}`;
      }
    }
    return Promise.reject(error);
  }
);
