import React, { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

import CodeProject from "./components/CodeProject";
import ListView from "./views/ListView";
import HistoryView from "./views/HistoryView";
import ExecutionsView from "./views/ExecutionsView";
import ResourcesView from "./views/ResourcesView";
import ApplicationsView from "./views/ApplicationsView";
import { ApplicationPackagesView } from "./views/ApplicationPackagesView";
import MainLayout from "./components/MainLayout";

import { lightTheme } from "./utils/theme";
import { ThemeProvider } from "@mui/material";
import { getConfig, AppConfig } from "./utils/api";

import "./index.css";

// Global handler to swallow the specific monaco-yaml schema error that triggers
// the full-screen overlay, without crashing the application.
window.addEventListener("unhandledrejection", (event) => {
  if (
    event.reason &&
    event.reason.message &&
    event.reason.message.includes(
      "Missing requestHandler or method: resetSchema"
    )
  ) {
    event.preventDefault();
  }
});

const DisabledModuleView: React.FC<{ message?: string }> = ({ message }) => (
  <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
    <div className="bg-amber-50 dark:bg-amber-950/40 p-4 rounded-full border border-amber-200 dark:border-amber-800/60 mb-4">
      <ExclamationTriangleIcon className="w-8 h-8 text-amber-600 dark:text-amber-400" />
    </div>
    <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-2">
      Module Disabled
    </h2>
    <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md">
      {message ||
        "Access to this management module is currently disabled for this environment."}
    </p>
  </div>
);

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);

  const setViewHeight = () => {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty("--vh", `${vh}px`);
  };

  useEffect(() => {
    setViewHeight();
    window.addEventListener("resize", setViewHeight);
    getConfig()
      .then((cfg) => setConfig(cfg))
      .catch(() => {});

    return () => {
      window.removeEventListener("resize", setViewHeight);
    };
  }, []);

  const isApplicationsDeployment =
    window.BASE_PATH?.includes("gitargo-applications") ||
    window.location.pathname.includes("gitargo-applications") ||
    window.location.pathname.includes("-applications");

  const isPackagesDeployment =
    window.BASE_PATH?.includes("gitargo-packages") ||
    window.location.pathname.includes("gitargo-packages") ||
    window.location.pathname.includes("-packages");

  const enableApplications =
    config?.enableApplications ?? isApplicationsDeployment;
  const enableOgcPackages = config?.enableOgcPackages ?? isPackagesDeployment;
  const enableWorkflows =
    config?.enableWorkflows ??
    (!isApplicationsDeployment && !isPackagesDeployment);

  const renderHomeView = () => {
    if (isApplicationsDeployment) {
      return <ApplicationsView />;
    }
    if (isPackagesDeployment) {
      return <ApplicationPackagesView />;
    }
    if (enableWorkflows) {
      return <ListView />;
    }
    if (enableApplications) {
      return <ApplicationsView />;
    }
    if (enableOgcPackages) {
      return <ApplicationPackagesView />;
    }
    return (
      <DisabledModuleView message="No management modules are currently enabled." />
    );
  };

  return (
    <ThemeProvider theme={lightTheme}>
      <Toaster />
      <MainLayout>
        <Routes>
          <Route path="/" element={renderHomeView()} />
          <Route
            path="/executions"
            element={
              enableWorkflows ? (
                <ExecutionsView />
              ) : (
                <DisabledModuleView message="Workflow Management is currently disabled." />
              )
            }
          />
          <Route
            path="/packages"
            element={
              enableOgcPackages ? (
                <ApplicationPackagesView />
              ) : (
                <DisabledModuleView message="OGC Application Package Management is currently disabled." />
              )
            }
          />
          <Route
            path="/resources"
            element={
              enableWorkflows ? (
                <ResourcesView />
              ) : (
                <DisabledModuleView message="Workflow Management is currently disabled." />
              )
            }
          />
          <Route
            path="/applications"
            element={
              enableApplications ? (
                <ApplicationsView />
              ) : (
                <DisabledModuleView message="Applications Management is currently disabled." />
              )
            }
          />
          <Route
            path="/new"
            element={
              enableWorkflows ? (
                <CodeProject />
              ) : (
                <DisabledModuleView message="Workflow Management is currently disabled." />
              )
            }
          />
          <Route
            path="/edit/:filename"
            element={
              enableWorkflows ? (
                <CodeProject />
              ) : (
                <DisabledModuleView message="Workflow Management is currently disabled." />
              )
            }
          />
          <Route
            path="/history/:filename"
            element={
              enableWorkflows ? (
                <HistoryView />
              ) : (
                <DisabledModuleView message="Workflow Management is currently disabled." />
              )
            }
          />
          <Route path="/workflows" element={<Navigate to="/" replace />} />
          {/* Fallback legacy routes */}
          <Route path="/new/*" element={<Navigate to="/new" replace />} />
          <Route path="/edit/*" element={<Navigate to="/" replace />} />
        </Routes>
      </MainLayout>
    </ThemeProvider>
  );
}
