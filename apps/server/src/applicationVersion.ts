import { readFileSync } from 'node:fs';
/** Source and compiled modules have the same distance to the repository package.json. */
export const applicationVersion: string = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
