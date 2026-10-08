/// <reference types="vite/client" />

/** The app version inlined by vite.renderer.config.ts at build time. `undefined` under
 * vitest/jsdom (no define), so read it guarded: `typeof __PROXYFARM_APP_VERSION__ !==
 * 'undefined' ? __PROXYFARM_APP_VERSION__ : 'dev'`. */
declare const __PROXYFARM_APP_VERSION__: string;
