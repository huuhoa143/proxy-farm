import { defineConfig } from 'vite';

// Nothing app-specific to define yet — kept as its own file (rather than
// folded into forge.config.ts) so later tasks can add `define`/`resolve`
// entries for the main-process controller without touching forge.config.ts.
export default defineConfig({});
