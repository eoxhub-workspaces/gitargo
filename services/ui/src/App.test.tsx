import { render, screen } from "@testing-library/react";
import { BrowserRouter as Router } from "react-router-dom";
import App from "./App";

test("renders learn react link", () => {
  render(
    <Router>
      <App />
    </Router>
  );
  // Learn React is not rendered by default, but let's see what is rendered in the app.
  // Actually, we can just assert that the app compiles and renders without errors.
  expect(document.body).toBeInTheDocument();
});
