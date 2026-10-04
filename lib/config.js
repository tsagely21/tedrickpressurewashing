import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env.js';

export const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.config.json'), 'utf8'));
