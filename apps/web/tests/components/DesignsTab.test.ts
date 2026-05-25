import { describe, expect, it } from 'vitest';

import {
  coreArtifactPathForProject,
  DEFAULT_DESIGN_SORT_MODE,
  sortDesignListItemsForDisplay,
  type DesignListItem,
  STATUS_LABEL_KEYS,
  STATUS_ORDER,
} from '../../src/components/DesignsTab';
import type { Project, ProjectDisplayStatus } from '../../src/types';

describe('DesignsTab status metadata', () => {
  it('places awaiting_input between running and succeeded', () => {
    expect(STATUS_ORDER).toEqual([
      'not_started',
      'running',
      'awaiting_input',
      'succeeded',
      'failed',
      'canceled',
    ]);
  });

  it('maps awaiting_input to the i18n label key', () => {
    expect(STATUS_LABEL_KEYS.awaiting_input).toBe('designs.status.awaitingInput');
  });
});

describe('coreArtifactPathForProject', () => {
  it('points project cards at the OpenPPT core artifact source', () => {
    expect(coreArtifactPathForProject(deckProject())).toBe('slides/main-deck/index.tsx');
  });

  it('honors custom slide workspace and slide id metadata', () => {
    expect(coreArtifactPathForProject({
      ...deckProject(),
      metadata: {
        kind: 'deck',
        slideWorkspace: 'chapters',
        slideId: 'launch-review',
      },
    })).toBe('chapters/launch-review/index.tsx');
  });

  it('does not create a core artifact preview path for non-deck projects', () => {
    expect(coreArtifactPathForProject({ ...deckProject(), metadata: { kind: 'prototype' } })).toBeNull();
  });
});

describe('project design sorting', () => {
  it('defaults to newest created first', () => {
    const sorted = sortDesignListItemsForDisplay([
      projectItem('Older', { createdAt: 100, updatedAt: 300 }),
      projectItem('Newest', { createdAt: 300, updatedAt: 100 }),
      projectItem('Middle', { createdAt: 200, updatedAt: 200 }),
    ]);

    expect(DEFAULT_DESIGN_SORT_MODE).toBe('created-desc');
    expect(sorted.map((item) => item.project.name)).toEqual(['Newest', 'Middle', 'Older']);
  });

  it('sorts by recently updated when requested', () => {
    const sorted = sortDesignListItemsForDisplay([
      projectItem('Created last', { createdAt: 300, updatedAt: 100 }),
      projectItem('Updated last', { createdAt: 100, updatedAt: 300 }),
    ], 'updated-desc');

    expect(sorted.map((item) => item.project.name)).toEqual(['Updated last', 'Created last']);
  });

  it('sorts names in both directions', () => {
    const items = [
      projectItem('Bravo'),
      projectItem('alpha'),
      projectItem('Charlie'),
    ];

    expect(sortDesignListItemsForDisplay(items, 'name-asc').map((item) => item.project.name)).toEqual([
      'alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(sortDesignListItemsForDisplay(items, 'name-desc').map((item) => item.project.name)).toEqual([
      'Charlie',
      'Bravo',
      'alpha',
    ]);
  });

  it('sorts statuses in the board workflow order', () => {
    const sorted = sortDesignListItemsForDisplay([
      projectItem('Done', { status: 'succeeded', updatedAt: 5 }),
      projectItem('Queued', { status: 'queued', updatedAt: 3 }),
      projectItem('Fresh', { status: 'not_started', updatedAt: 4 }),
      projectItem('Needs input', { status: 'awaiting_input', updatedAt: 2 }),
    ], 'status');

    expect(sorted.map((item) => item.project.name)).toEqual([
      'Fresh',
      'Queued',
      'Needs input',
      'Done',
    ]);
  });
});

function deckProject(): Project {
  return {
    id: 'project-1',
    name: 'Deck project',
    skillId: 'openppt-deck',
    designSystemId: null,
    createdAt: 1,
    updatedAt: 1,
    metadata: {
      kind: 'deck',
      slideId: 'main-deck',
    },
  };
}

function projectItem(
  name: string,
  options: {
    createdAt?: number;
    updatedAt?: number;
    status?: ProjectDisplayStatus;
  } = {},
): DesignListItem {
  const createdAt = options.createdAt ?? 1;
  const updatedAt = options.updatedAt ?? createdAt;
  return {
    type: 'project',
    project: {
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      skillId: 'openppt-deck',
      designSystemId: null,
      createdAt,
      updatedAt,
      metadata: {
        kind: 'deck',
      },
      ...(options.status
        ? {
            status: {
              value: options.status,
              updatedAt,
            },
          }
        : {}),
    },
    updatedAt,
  };
}
