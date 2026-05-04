import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";

import SideBar from "./components/global/SideBar";
import Project from "./components/Project";
import ListView from "./views/ListView";
import HistoryView from "./views/HistoryView";

import { lightTheme } from "./utils/theme";
import { ThemeProvider } from "@mui/material";

import "./index.css";

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
      <SideBar />
      <Routes>
        <Route path="/" element={<ListView />} />
        <Route path="/new" element={<Project />} />
        <Route path="/edit/:filename" element={<Project />} />
        <Route path="/history/:filename" element={<HistoryView />} />
        <Route path="/workflows" element={<Navigate to="/" replace />} />
      </Routes>
    </ThemeProvider>
  );
}
