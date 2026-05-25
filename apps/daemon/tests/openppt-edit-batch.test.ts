import { describe, expect, it } from 'vitest';

import { applyOpenPptEditBatch } from '../src/server.js';

describe('applyOpenPptEditBatch', () => {
  it('treats edits that are already reflected in source as successful no-ops', async () => {
    const source = `
import type { Page } from '@open-slide/core';

const Cover: Page = () => (
  <div>
    <h1 style={{ color: "red" }}>Hello</h1>
  </div>
);

export default [Cover] satisfies Page[];
`;

    const result = await applyOpenPptEditBatch(source, [
      {
        line: 6,
        column: 4,
        ops: [{ kind: 'set-style', key: 'color', value: 'red' }],
      },
    ]);

    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
    expect(result.results).toEqual([{ ok: true, changed: false }]);
  });
});
