const test = require('node:test');
const assert = require('node:assert');
const { parseWorkflowMetadata } = require('./workflowRoutes');

test('parseWorkflowMetadata parses Argo v4 CronWorkflow with spec.schedules list', () => {
  const cronYaml = `
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: nightly-job
spec:
  schedules:
    - "@daily"
  workflowSpec:
    entrypoint: execute
`;

  const meta = parseWorkflowMetadata(cronYaml);
  assert.ok(meta);
  assert.strictEqual(meta.kind, 'CronWorkflow');
  assert.strictEqual(meta.schedule, '@daily');
  assert.strictEqual(meta.entrypoint, 'execute');
});

test('parseWorkflowMetadata parses legacy Argo v3 CronWorkflow with spec.schedule string', () => {
  const legacyCronYaml = `
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: legacy-job
spec:
  schedule: "0 2 * * *"
  workflowSpec:
    entrypoint: main
`;

  const meta = parseWorkflowMetadata(legacyCronYaml);
  assert.ok(meta);
  assert.strictEqual(meta.kind, 'CronWorkflow');
  assert.strictEqual(meta.schedule, '0 2 * * *');
  assert.strictEqual(meta.entrypoint, 'main');
});

test('parseWorkflowMetadata parses Workflow and WorkflowTemplate', () => {
  const wfYaml = `
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: sample-wf
spec:
  entrypoint: run-all
`;

  const meta = parseWorkflowMetadata(wfYaml);
  assert.ok(meta);
  assert.strictEqual(meta.kind, 'Workflow');
  assert.strictEqual(meta.schedule, null);
  assert.strictEqual(meta.entrypoint, 'run-all');
});
