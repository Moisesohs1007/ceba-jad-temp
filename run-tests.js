const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
  'tests/analyze_audit_test.js',
  'tests/cost_sim_test.js',
  'tests/materiales_flow_test.js',
  'tests/reportes_metrics_test.js',
];

for (const relativePath of tests) {
  const fullPath = path.join(__dirname, relativePath);
  const result = spawnSync(process.execPath, [fullPath], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
