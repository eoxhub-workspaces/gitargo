import { useEffect } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "react-hot-toast";

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

export default function App() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const isCwlUrlPresent = Boolean(
    searchParams.get("cwlUrl") || searchParams.get("url")
  );

  const setViewHeight = () => {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty("--vh", `${vh}px`);
  };

  useEffect(() => {
    setViewHeight();
    window.addEventListener("resize", setViewHeight);

    return () => {
      window.removeEventListener("resize", setViewHeight);
    };
  }, []);

  const isApplicationsDeployment =
    window.BASE_PATH?.includes("gitargo-applications") ||
    window.location.pathname.includes("gitargo-applications") ||
    window.location.pathname.includes("-applications");

  return (
    <ThemeProvider theme={lightTheme}>
      <Toaster />
      <MainLayout>
        <Routes>
          <Route
            path="/"
            element={
              isCwlUrlPresent ? (
                <ApplicationPackagesView />
              ) : isApplicationsDeployment ? (
                <ApplicationsView />
              ) : (
                <ListView />
              )
            }
          />
          <Route path="/executions" element={<ExecutionsView />} />
          <Route path="/packages" element={<ApplicationPackagesView />} />
          <Route path="/resources" element={<ResourcesView />} />
          <Route path="/applications" element={<ApplicationsView />} />
          <Route path="/new" element={<CodeProject />} />
          <Route path="/edit/:filename" element={<CodeProject />} />
          <Route path="/history/:filename" element={<HistoryView />} />
          <Route path="/workflows" element={<Navigate to="/" replace />} />
          {/* Fallback legacy routes */}
          <Route path="/new/*" element={<Navigate to="/new" replace />} />
          <Route path="/edit/*" element={<Navigate to="/" replace />} />
        </Routes>
      </MainLayout>
    </ThemeProvider>
  );
}
