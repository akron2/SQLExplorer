// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('connection lifecycle policy', () => {
  const worker = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'db-worker.ts'), 'utf8');
  const manager = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'database-runtime-manager.ts'), 'utf8');

  it('contains no application-level periodic ping or probe query', () => {
    expect(worker).not.toMatch(/\.ping\s*\(/u);
    expect(worker).not.toMatch(/setInterval\s*\(/u);
    expect(manager).not.toMatch(/setInterval\s*\(/u);
    expect(worker).not.toMatch(/['"`]\s*select\s+1\s*['"`]/iu);
  });

  it('dispatches one worker execute call for each manager execute request', () => {
    const executeMethod = manager.slice(manager.indexOf('async execute('), manager.indexOf('async fetchMore('));
    expect(executeMethod.match(/\.call<QueryPage>\('execute'/gu)).toHaveLength(1);
    expect(executeMethod).not.toMatch(/retry|attempt/iu);
  });
});
