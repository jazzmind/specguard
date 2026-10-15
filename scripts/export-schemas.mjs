// Regenerates the published JSON Schemas from the zod definitions in src/.
// Run `npm run build && npm run schemas`. A test fails when the committed files are stale.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PLAN_SCHEMA_FILE, remediationPlanJsonSchema } from '../dist/core/remediation-schema.js';

mkdirSync(dirname(PLAN_SCHEMA_FILE), { recursive: true });
writeFileSync(PLAN_SCHEMA_FILE, `${JSON.stringify(remediationPlanJsonSchema(), null, 2)}\n`);
console.log(`wrote ${PLAN_SCHEMA_FILE}`);
