import {signal, type Signal} from '@preact/signals-core';
import type {
  CameraMood,
  Palette,
  SimulationDebugStats,
} from '../shared/types.ts';

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export class Burst {
  id: Signal<string>;
  kind: Signal<string>;
  strength: Signal<number>;
  origin: Signal<[number, number, number]>;
  life: Signal<number>;

  constructor(
    kind: string,
    strength: number,
    origin: [number, number, number],
  ) {
    this.id = signal(uid('burst'));
    this.kind = signal(kind);
    this.strength = signal(strength);
    this.origin = signal(origin);
    this.life = signal(1);
  }
}

export class Cluster {
  id: Signal<string>;
  label: Signal<string>;
  mass: Signal<number>;
  position: Signal<[number, number, number]>;
  velocity: Signal<[number, number, number]>;
  heat: Signal<number>;

  constructor(label: string) {
    this.id = signal(uid('cluster'));
    this.label = signal(label);
    this.mass = signal(1);
    this.position = signal([0, 0, 0]);
    this.velocity = signal([0, 0, 0]);
    this.heat = signal(0.5);
  }

  pin() {
    this.velocity.value = [0, 0, 0];
  }
}

export class VisualScene {
  id: Signal<string>;
  cameraMood: Signal<CameraMood>;
  entropy: Signal<number>;
  palette: Signal<Palette>;
  bursts: Signal<Burst[]>;
  clusters: Signal<Cluster[]>;
  trails: Signal<number[]>;
  fpsHint: Signal<number>;
  debugStats: Signal<SimulationDebugStats>;

  constructor() {
    this.id = signal('visuals');
    this.cameraMood = signal('orbit');
    this.entropy = signal(0.25);
    this.palette = signal({
      bg: '#0b1020',
      accents: ['#8ecae6', '#ffb703', '#fb8500'],
      glow: '#ffffff',
    });
    this.bursts = signal([]);
    this.clusters = signal([
      new Cluster('Choir Halo'),
      new Cluster('Pulse Well'),
    ]);
    this.trails = signal([]);
    this.fpsHint = signal(60);
    this.debugStats = signal({particles: 0, springs: 0, drawCalls: 0});
  }

  igniteFromMotif(motifId: string) {
    this.bursts.value = [
      ...this.bursts.value,
      new Burst('motif', 0.85, [0, 0, 0]),
    ];
    this.entropy.value = Math.min(1, this.entropy.value + 0.1);
    this.debugStats.value = {
      ...this.debugStats.value,
      particles: this.debugStats.value.particles + 128,
    };
    this.palette.value = {...this.palette.value, glow: motifId.slice(0, 7)};
  }

  focusSection(sectionId: string) {
    this.cameraMood.value = 'dive';
    this.trails.value = [...this.trails.value, sectionId.length];
  }

  collapse() {
    this.cameraMood.value = 'collapse';
    this.entropy.value = Math.min(1, this.entropy.value + 0.2);
  }

  stabilize() {
    this.cameraMood.value = 'orbit';
    this.entropy.value = Math.max(0, this.entropy.value - 0.15);
  }
}
