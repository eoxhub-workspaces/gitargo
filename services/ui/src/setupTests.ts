// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import "@testing-library/jest-dom";
import { vi } from "vitest";

// Globally mock API calls to avoid ECONNREFUSED network errors in jsdom during component testing
vi.mock("./utils/api", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getConfig: vi.fn().mockResolvedValue({
      enableWorkflows: true,
      enableOgcPackages: true,
      enableApplications: true,
      version: "0.6.2"
    }),
    getPackages: vi.fn().mockResolvedValue([]),
    getExecutions: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
    getPublishedWorkflows: vi.fn().mockResolvedValue([]),
    getApplications: vi.fn().mockResolvedValue([])
  };
});
