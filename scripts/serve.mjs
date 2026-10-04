// npm run dev: build the site and preview it at http://localhost:3000 (talks to the Supabase project in the config).
import { build } from '../build.mjs';
import { serve } from './static-server.mjs';

const port = Number(process.env.PORT) || 3000;
serve(build(), port);
console.log(`\nPreview: http://localhost:${port}   Owner dashboard: http://localhost:${port}/admin/\nRe-run "npm run dev" after editing config/ or public/.\n`);
