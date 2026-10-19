import { render, screen } from "@testing-library/react";
import { BrowserRouter as Router } from "react-router-dom";
import { ApplicationPackagesView } from "./ApplicationPackagesView";

test("renders OGC Application Packages page title and input field", () => {
  render(
    <Router>
      <ApplicationPackagesView />
    </Router>
  );

  expect(
    screen.getByRole("heading", { name: /OGC Application Packages/i })
  ).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/package.cwl/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Fetch Package/i })).toBeInTheDocument();
});
