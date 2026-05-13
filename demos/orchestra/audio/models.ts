import {signal, type Signal} from '@preact/signals-core';
import type {
  MotifKind,
  MotifStatus,
  OrchestraEventSnapshot,
  OrchestraPhase,
} from '../shared/types.ts';

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export class Performer {
  id: Signal<string>;
  label: Signal<string>;
  color: Signal<string>;
  instrument: Signal<string>;
  confidence: Signal<number>;
  lastHitAt: Signal<number>;

  constructor(label: string, instrument: string, color = '#ffffff') {
    this.id = signal(uid('performer'));
    this.label = signal(label);
    this.color = signal(color);
    this.instrument = signal(instrument);
    this.confidence = signal(0.5);
    this.lastHitAt = signal(0);
  }

  accent() {
    this.lastHitAt.value = Date.now();
    this.confidence.value = Math.min(1, this.confidence.value + 0.05);
  }
}

export class Section {
  id: Signal<string>;
  name: Signal<string>;
  energy: Signal<number>;
  density: Signal<number>;
  active: Signal<boolean>;
  performers: Signal<Performer[]>;
  patternPreview: Signal<number[]>;

  constructor(name: string, performers: Performer[] = []) {
    this.id = signal(uid('section'));
    this.name = signal(name);
    this.energy = signal(0.5);
    this.density = signal(0.5);
    this.active = signal(true);
    this.performers = signal(performers);
    this.patternPreview = signal([1, 0, 0, 1, 0, 1, 0, 0]);
  }

  mute() {
    this.active.value = false;
  }

  unmute() {
    this.active.value = true;
  }

  mutate(energyBias: number) {
    this.energy.value = Math.max(
      0,
      Math.min(1, this.energy.value + energyBias),
    );
    this.density.value = Math.max(
      0,
      Math.min(1, this.density.value + energyBias * 0.5),
    );
  }
}

export class Motif {
  id: Signal<string>;
  kind: Signal<MotifKind>;
  score: Signal<number>;
  shape: Signal<number[]>;
  status: Signal<MotifStatus>;

  constructor(kind: MotifKind, shape: number[]) {
    this.id = signal(uid('motif'));
    this.kind = signal(kind);
    this.score = signal(0);
    this.shape = signal(shape);
    this.status = signal('candidate');
  }

  adopt() {
    this.status.value = 'adopted';
    this.score.value = Math.max(this.score.value, 0.8);
  }

  discard() {
    this.status.value = 'retired';
  }
}

export class Orchestra {
  id: Signal<string>;
  tempo: Signal<number>;
  beat: Signal<number>;
  phase: Signal<OrchestraPhase>;
  tension: Signal<number>;
  sections: Signal<Section[]>;
  motifs: Signal<Motif[]>;
  eventLog: Signal<OrchestraEventSnapshot[]>;
  streamText: Signal<string>;

  constructor() {
    this.id = signal('orchestra');
    this.tempo = signal(120);
    this.beat = signal(0);
    this.phase = signal('idle');
    this.tension = signal(0.15);
    this.sections = signal([
      new Section('Percussion', [
        new Performer('Pulse Engine', 'drums', '#ffb703'),
      ]),
      new Section('Choir', [new Performer('Glass Voice', 'voice', '#8ecae6')]),
    ]);
    this.motifs = signal([]);
    this.eventLog = signal([]);
    this.streamText = signal('The orchestra is waiting for a motif.');
  }

  seed(theme: string) {
    this.phase.value = 'build';
    this.streamText.value = `Conductor hears ${theme}.`;
    this.pushEvent('seed', `Seeded orchestra with theme: ${theme}`);
  }

  dropBeat(seed: string) {
    this.phase.value = 'drop';
    this.beat.value += 1;
    this.tension.value = Math.min(1, this.tension.value + 0.2);
    this.streamText.value += ` Drop hits on ${seed}.`;
    this.pushEvent('drop', `Drop triggered with seed: ${seed}`);
  }

  setTempo(next: number) {
    this.tempo.value = next;
    this.pushEvent('tempo', `Tempo changed to ${next} BPM`);
  }

  promoteMotif(motifId: string) {
    const motifs = this.motifs.value;
    for (let i = 0; i < motifs.length; i++) {
      if (motifs[i].id.value === motifId) {
        motifs[i].adopt();
        this.pushEvent('motif', `Promoted motif ${motifId}`);
        return;
      }
    }
  }

  solo(sectionId: string) {
    const sections = this.sections.value;
    for (let i = 0; i < sections.length; i++) {
      sections[i].active.value = sections[i].id.value === sectionId;
    }
    this.pushEvent('solo', `Soloed section ${sectionId}`);
  }

  freeze() {
    this.phase.value = 'aftermath';
    this.pushEvent('freeze', 'Performance frozen');
  }

  rewindTo(bar: number) {
    this.beat.value = Math.max(0, bar);
    this.phase.value = 'build';
    this.pushEvent('rewind', `Rewound to beat ${bar}`);
  }

  addMotif(kind: MotifKind, shape: number[]) {
    const motif = new Motif(kind, shape);
    this.motifs.value = [...this.motifs.value, motif];
    this.streamText.value += ` New motif ${motif.id.value} enters.`;
    this.pushEvent('motif', `Added ${kind} motif ${motif.id.value}`);
    return motif;
  }

  private pushEvent(type: string, message: string) {
    const event: OrchestraEventSnapshot = {
      id: uid('event'),
      type,
      message,
      atBeat: this.beat.value,
    };
    this.eventLog.value = [...this.eventLog.value, event];
  }
}
