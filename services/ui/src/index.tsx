import "./setupErrorHandling";
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter as Router } from "react-router-dom";
import App from "./App";
import reportWebVitals from "./reportWebVitals";

declare global {
  interface Window {
    BASE_PATH?: string;
  }
}

// Dynamically determine the basename for React Router.
// If window.BASE_PATH is set by the server, use it.
// Otherwise, try to infer it from the current URL if we are behind a proxy that didn't set it.
const getBasename = () => {
  if (window.BASE_PATH && window.BASE_PATH !== "") {
    return window.BASE_PATH;
  }

  // If no base path is injected, look at the current URL.
  // We want to strip off the known React app routes (like /new, /edit, /history)
  // to find the root where the app is mounted.
  const path = window.location.pathname;

  // Regular expression to match our known frontend routes
  const knownRoutesRegex = /\/(new|edit|history|workflows)(\/|$)/;
  const match = path.match(knownRoutesRegex);

  if (match) {
    // If we matched a known route, the basename is everything before it.
    // e.g., /services/argo/new/code -> /services/argo
    return path.substring(0, match.index) || "/";
  }

  // If we are at the root or an unknown route, assume the current path is the basename
  // (stripping trailing slash).
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
};

const basename = getBasename();
console.log("React Router Basename set to:", basename);
window.BASE_PATH = basename !== "/" ? basename : ""; // Sync the global for Axios

const container = document.getElementById("root");
const root = createRoot(container!);
root.render(
  <React.StrictMode>
    <Router basename={basename}>
      <App />
    </Router>
  </React.StrictMode>
);

reportWebVitals();
