const test = require('node:test');
const assert = require('node:assert');
const {
  checkIsKev,
  parseEpssScore,
  determineActionRequired,
  parseContainerReport
} = require('./applicationRoutes');

test('checkIsKev identifies KEV vulnerabilities accurately', () => {
  assert.strictEqual(checkIsKev({ knownExploitable: true }), true);
  assert.strictEqual(checkIsKev({ knownExploitable: 'true' }), true);
  assert.strictEqual(checkIsKev({ kev: true }), true);
  assert.strictEqual(checkIsKev({ isKev: true }), true);
  assert.strictEqual(checkIsKev({ cisaKev: true }), true);
  assert.strictEqual(checkIsKev({ vendorAttributes: { KEV: true } }), true);
  assert.strictEqual(checkIsKev({ primaryLink: 'https://www.cisa.gov/known-exploitable-vulnerabilities-catalog' }), true);
  assert.strictEqual(checkIsKev({ knownExploitable: false, severity: 'HIGH' }), false);
});

test('parseEpssScore parses various EPSS score formats correctly', () => {
  assert.strictEqual(parseEpssScore({ epssScore: 0.854 }), 0.854);
  assert.strictEqual(parseEpssScore({ epssScore: '85.4%' }), 0.854);
  assert.strictEqual(parseEpssScore({ epssScore: '0.12' }), 0.12);
  assert.strictEqual(parseEpssScore({ epss: { score: 0.45 } }), 0.45);
  assert.strictEqual(parseEpssScore({ epss_score: 95.0 }), 0.95);
  assert.strictEqual(parseEpssScore({}), null);
});

test('determineActionRequired evaluates actionability threshold correctly', () => {
  // KEV implies action required
  assert.strictEqual(determineActionRequired(true, 0.001, false, 'LOW'), true);
  // High EPSS >= 0.10 implies action required
  assert.strictEqual(determineActionRequired(false, 0.15, false, 'LOW'), true);
  // Fixable Critical / High implies action required
  assert.strictEqual(determineActionRequired(false, 0.01, true, 'CRITICAL'), true);
  assert.strictEqual(determineActionRequired(false, 0.01, true, 'HIGH'), true);
  // Unfixable low EPSS non-KEV medium/low does not require action
  assert.strictEqual(determineActionRequired(false, 0.02, false, 'HIGH'), false);
  assert.strictEqual(determineActionRequired(false, 0.05, true, 'MEDIUM'), false);
});

test('parseContainerReport generates comprehensive actionable report and summary', () => {
  const sampleTrivyCRD = {
    metadata: {
      name: 'replicaset-my-app-12345',
      labels: {
        'trivy-operator.container.name': 'app-container'
      }
    },
    report: {
      summary: {
        criticalCount: 2,
        highCount: 1,
        mediumCount: 2,
        lowCount: 5
      },
      vulnerabilities: [
        {
          vulnerabilityID: 'CVE-2023-9999',
          title: 'Unexploited low risk issue',
          severity: 'LOW',
          resource: 'libpng',
          installedVersion: '1.2.0',
          fixedVersion: '',
          epssScore: 0.001
        },
        {
          vulnerabilityID: 'CVE-2023-0001',
          title: 'Active CISA KEV exploit',
          severity: 'HIGH',
          resource: 'openssl',
          installedVersion: '3.0.1',
          fixedVersion: '3.0.2',
          knownExploitable: true,
          epssScore: '88.5%'
        },
        {
          vulnerabilityID: 'CVE-2023-0002',
          title: 'High EPSS prediction score',
          severity: 'MEDIUM',
          resource: 'curl',
          installedVersion: '7.8.0',
          fixedVersion: '7.8.1',
          epssScore: 0.25
        }
      ]
    }
  };

  const parsed = parseContainerReport(sampleTrivyCRD);
  assert.strictEqual(parsed.container, 'app-container');
  assert.strictEqual(parsed.summary.totalCount, 3);
  assert.strictEqual(parsed.summary.actionRequiredCount, 2);
  assert.strictEqual(parsed.summary.kevCount, 1);
  assert.strictEqual(parsed.summary.highEpssCount, 2);
  assert.strictEqual(parsed.summary.fixableCount, 2);

  // First item in sorted list should be the action-required KEV item
  assert.strictEqual(parsed.topVulnerabilities[0].id, 'CVE-2023-0001');
  assert.strictEqual(parsed.topVulnerabilities[0].isKev, true);
  assert.strictEqual(parsed.topVulnerabilities[0].epssPercentage, '88.5%');
  assert.strictEqual(parsed.topVulnerabilities[0].actionRequired, true);

  // Second item should be the High EPSS item
  assert.strictEqual(parsed.topVulnerabilities[1].id, 'CVE-2023-0002');
  assert.strictEqual(parsed.topVulnerabilities[1].actionRequired, true);

  // Third item should be unexploited low risk item
  assert.strictEqual(parsed.topVulnerabilities[2].id, 'CVE-2023-9999');
  assert.strictEqual(parsed.topVulnerabilities[2].actionRequired, false);
});
