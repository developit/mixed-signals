import {signal, type Signal} from '@preact/signals-core';
import type {
  AudienceMemberSnapshot,
  DebugEvent,
  RealmInfo,
  SessionCheckpointSnapshot,
  SessionPhase,
  SubscriptionEdge,
  TransportStats,
  VoteBucketSnapshot,
} from '../shared/types.ts';

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export class Session {
  id: Signal<string>;
  roomId: Signal<string>;
  title: Signal<string>;
  phase: Signal<SessionPhase>;
  connectedClients: Signal<number>;
  directorNote: Signal<string>;
  history: Signal<SessionCheckpointSnapshot[]>;

  constructor() {
    this.id = signal('session');
    this.roomId = signal('orchestra-room');
    this.title = signal('The Impossible Orchestra');
    this.phase = signal('lobby');
    this.connectedClients = signal(0);
    this.directorNote = signal('Waiting for the first motif.');
    this.history = signal([]);
  }

  start(theme: string) {
    this.phase.value = 'performing';
    this.directorNote.value = `Beginning performance with ${theme}.`;
    this.pushCheckpoint(`Started with ${theme}`);
  }

  freezeDrop() {
    this.phase.value = 'frozen';
    this.directorNote.value = 'Drop frozen in place.';
    this.pushCheckpoint('Freeze drop');
  }

  resume() {
    this.phase.value = 'performing';
    this.directorNote.value = 'Performance resumed.';
    this.pushCheckpoint('Resume');
  }

  rewind(checkpointId: string) {
    this.phase.value = 'replay';
    this.directorNote.value = `Rewinding to ${checkpointId}.`;
  }

  private pushCheckpoint(label: string) {
    this.history.value = [
      ...this.history.value,
      {id: uid('checkpoint'), label, capturedAt: Date.now()},
    ];
  }
}

export class Audience {
  id: Signal<string>;
  globalTheme: Signal<string>;
  votes: Signal<VoteBucketSnapshot[]>;
  presence: Signal<AudienceMemberSnapshot[]>;
  energy: Signal<number>;

  constructor() {
    this.id = signal('audience');
    this.globalTheme = signal('neon cathedral rain');
    this.votes = signal([
      {id: 'theme-neon', label: 'Neon Rain', votes: 0},
      {id: 'theme-glass', label: 'Glass Choir', votes: 0},
    ]);
    this.presence = signal([]);
    this.energy = signal(0.2);
  }

  vote(bucketId: string) {
    const nextVotes = [...this.votes.value];
    for (let i = 0; i < nextVotes.length; i++) {
      if (nextVotes[i].id === bucketId) {
        nextVotes[i] = {...nextVotes[i], votes: nextVotes[i].votes + 1};
      }
    }
    this.votes.value = nextVotes;
    this.energy.value = Math.min(1, this.energy.value + 0.05);
  }

  setTheme(next: string) {
    this.globalTheme.value = next;
  }
}

export class DebugHub {
  id: Signal<string>;
  realms: Signal<RealmInfo[]>;
  subscriptions: Signal<SubscriptionEdge[]>;
  transportStats: Signal<TransportStats>;
  lastEvents: Signal<DebugEvent[]>;
  selectedSignal: Signal<string | null>;
  overlayVisible: Signal<boolean>;

  constructor() {
    this.id = signal('debug');
    this.realms = signal([
      {
        id: 'realm-ui',
        name: 'ui',
        label: 'UI',
        color: '#ffffff',
        status: 'online',
      },
      {
        id: 'realm-audio',
        name: 'audio',
        label: 'Audio Worker',
        color: '#ffb703',
        status: 'online',
      },
      {
        id: 'realm-visual',
        name: 'visual',
        label: 'Visual Worker',
        color: '#8ecae6',
        status: 'offline',
      },
      {
        id: 'realm-broker',
        name: 'broker',
        label: 'Broker',
        color: '#c77dff',
        status: 'online',
      },
    ]);
    this.subscriptions = signal([]);
    this.transportStats = signal({
      framesIn: 0,
      framesOut: 0,
      signalUpdates: 0,
      methodCalls: 0,
    });
    this.lastEvents = signal([]);
    this.selectedSignal = signal(null);
    this.overlayVisible = signal(true);
  }

  selectSignal(id: string) {
    this.selectedSignal.value = id;
    this.pushEvent('select-signal', `Selected signal ${id}`);
  }

  toggleOverlay() {
    this.overlayVisible.value = !this.overlayVisible.value;
    this.pushEvent(
      'toggle-overlay',
      `Overlay ${this.overlayVisible.value ? 'shown' : 'hidden'}`,
    );
  }

  incrementTransport(kind: keyof TransportStats, amount = 1) {
    this.transportStats.value = {
      ...this.transportStats.value,
      [kind]: this.transportStats.value[kind] + amount,
    };
  }

  private pushEvent(type: string, detail: string) {
    this.lastEvents.value = [
      ...this.lastEvents.value,
      {id: uid('debug-event'), type, detail, at: Date.now()},
    ];
  }
}
