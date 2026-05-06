import { useEffect } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { Toaster } from "react-hot-toast";

import Project from "./components/Project";
import CodeProject from "./components/CodeProject";
import ListView from "./views/ListView";
import HistoryView from "./views/HistoryView";

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

// A wrapper to dispatch between the dedicated Code view and the Canvas/Split view
const ModeDispatcher = () => {
  const { mode } = useParams<{ mode: string }>();
  if (mode === "code") {
    return <CodeProject />;
  }
  return <Project />;
};

export default function App() {
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

  return (
    <ThemeProvider theme={lightTheme}>
      <Toaster />
      <Routes>
        <Route path="/" element={<ListView />} />
        <Route path="/new/:mode" element={<ModeDispatcher />} />
        <Route path="/edit/:mode/:filename" element={<ModeDispatcher />} />
        <Route path="/history/:filename" element={<HistoryView />} />
        <Route path="/workflows" element={<Navigate to="/" replace />} />
        {/* Legacy routes fallback */}
        <Route path="/new" element={<Navigate to="/new/code" replace />} />
        <Route
          path="/edit/:filename"
          element={<Navigate to="/edit/code/:filename" replace />}
        />
      </Routes>
    </ThemeProvider>
  );
}
