import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MainLayout from "./MainLayout";
import { describe, it, expect, afterEach } from "vitest";

describe("MainLayout", () => {
  const originalBasePath = window.BASE_PATH;

  afterEach(() => {
    window.BASE_PATH = originalBasePath;
  });

  it("renders top navbar without Applications link when on root route", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <MainLayout>
          <div>Root Content</div>
        </MainLayout>
      </MemoryRouter>
    );

    expect(screen.getByText("Workflow Definitions")).toBeInTheDocument();
    expect(screen.getByText("Workflow Executions")).toBeInTheDocument();
    expect(screen.getByText("Resources Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Applications")).not.toBeInTheDocument();
    expect(screen.getByText("Root Content")).toBeInTheDocument();
  });

  it("does not render top navbar when on /applications route", () => {
    render(
      <MemoryRouter initialEntries={["/applications"]}>
        <MainLayout>
          <div>Applications Content</div>
        </MainLayout>
      </MemoryRouter>
    );

    expect(screen.queryByText("Workflow Definitions")).not.toBeInTheDocument();
    expect(screen.queryByText("Workflow Executions")).not.toBeInTheDocument();
    expect(screen.queryByText("Resources Dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("Applications")).not.toBeInTheDocument();
    expect(screen.getByText("Applications Content")).toBeInTheDocument();
  });

  it("does not render top navbar when window.BASE_PATH indicates gitargo-applications deployment", () => {
    window.BASE_PATH =
      "/services/eoxhub-gateway/hub-test-ws1/gitargo-applications";

    render(
      <MemoryRouter initialEntries={["/"]}>
        <MainLayout>
          <div>Applications Deployment Content</div>
        </MainLayout>
      </MemoryRouter>
    );

    expect(screen.queryByText("Workflow Definitions")).not.toBeInTheDocument();
    expect(
      screen.getByText("Applications Deployment Content")
    ).toBeInTheDocument();
  });
});
