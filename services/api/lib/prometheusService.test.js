const test = require('node:test');
const assert = require('node:assert');
const { parsePrometheusValue } = require('./prometheusService');

test('parsePrometheusValue extracts scalar number from vector query result', () => {
  const data = {
    result: [
      {
        metric: {},
        value: [1700000000, "157286400"]
      }
    ]
  };
  const val = parsePrometheusValue(data);
  assert.strictEqual(val, 157286400);
});

test('parsePrometheusValue returns 0 on empty or invalid data', () => {
  assert.strictEqual(parsePrometheusValue(null), 0);
  assert.strictEqual(parsePrometheusValue({ result: [] }), 0);
  assert.strictEqual(parsePrometheusValue({ result: [{ value: [100, "invalid"] }] }), 0);
});
