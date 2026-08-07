import {createReflectedModel} from '../../../client/model.ts';
import type {
  AudienceApi,
  BurstApi,
  ClusterApi,
  DebugHubApi,
  MotifApi,
  OrchestraApi,
  PerformerApi,
  SectionApi,
  SessionApi,
  VisualSceneApi,
} from '../shared/types.ts';

export const PerformerModel = createReflectedModel<PerformerApi>(
  ['id', 'label', 'color', 'instrument', 'confidence', 'lastHitAt'],
  ['accent'],
);

export const SectionModel = createReflectedModel<SectionApi>(
  ['id', 'name', 'energy', 'density', 'active', 'performers', 'patternPreview'],
  ['mute', 'unmute', 'mutate'],
);

export const MotifModel = createReflectedModel<MotifApi>(
  ['id', 'kind', 'score', 'shape', 'status'],
  ['adopt', 'discard'],
);

export const OrchestraModel = createReflectedModel<OrchestraApi>(
  [
    'id',
    'tempo',
    'beat',
    'phase',
    'tension',
    'sections',
    'motifs',
    'eventLog',
    'streamText',
  ],
  [
    'seed',
    'dropBeat',
    'setTempo',
    'promoteMotif',
    'solo',
    'freeze',
    'rewindTo',
  ],
);

export const ClusterModel = createReflectedModel<ClusterApi>(
  ['id', 'label', 'mass', 'position', 'velocity', 'heat'],
  ['pin'],
);

export const BurstModel = createReflectedModel<BurstApi>(
  ['id', 'kind', 'strength', 'origin', 'life'],
  [],
);

export const VisualSceneModel = createReflectedModel<VisualSceneApi>(
  [
    'id',
    'cameraMood',
    'entropy',
    'palette',
    'bursts',
    'clusters',
    'trails',
    'fpsHint',
    'debugStats',
  ],
  ['igniteFromMotif', 'focusSection', 'collapse', 'stabilize'],
);

export const SessionModel = createReflectedModel<SessionApi>(
  [
    'id',
    'roomId',
    'title',
    'phase',
    'connectedClients',
    'directorNote',
    'history',
  ],
  ['start', 'freezeDrop', 'resume', 'rewind'],
);

export const AudienceModel = createReflectedModel<AudienceApi>(
  ['id', 'globalTheme', 'votes', 'presence', 'energy'],
  ['vote', 'setTheme'],
);

export const DebugHubModel = createReflectedModel<DebugHubApi>(
  [
    'id',
    'realms',
    'subscriptions',
    'transportStats',
    'lastEvents',
    'selectedSignal',
  ],
  ['selectSignal', 'toggleOverlay'],
);
