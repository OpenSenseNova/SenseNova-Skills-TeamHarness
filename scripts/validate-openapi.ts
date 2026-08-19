import { createConfig, lint } from '@redocly/openapi-core';

const config = await createConfig({
  extends: ['recommended'],
  rules: {
    'operation-summary': 'warn',
    'security-defined': 'warn',
  },
});
const problems = await lint({ ref: 'docs/contracts/openapi.json', config });
const errors = problems.filter((problem) => problem.severity === 'error');
if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`${error.ruleId}: ${error.message}\n`);
  }
  process.exitCode = 1;
} else {
  const warnings = problems.filter((problem) => problem.severity === 'warn').length;
  process.stdout.write(`OpenAPI valid: 0 errors, ${warnings} style warnings.\n`);
}
