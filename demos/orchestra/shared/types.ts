import type {Signal} from '@preact/signals-core';

export type RealmName = 'ui' | 'audio' | 'visual' | 'broker' | 'audience';
export type OrchestraPhase = 'idle' | 'build' | 'drop' | 'aftermath';
export type SessionPhase = 'lobby' | 'performing' | 'frozen' | 'replay';
export type CameraMood = 'orbit' | 'dive' | 'collapse' | 'choir';
export type MotifKind = 'drawn' | 'spoken' | 'generated';
export type MotifStatus = 'candidate' | 'adopted' | 'retired';

export interface Palette {
  bg: string;
  accents: string[];
  glow: string;
}

export interface TransportStats {
  framesIn: number;
  framesOut: number;
  signalUpdates: number;
  methodCalls: number;
}

export interface SimulationDebugStats {
  particles: number;
  springs: number;
  drawCalls: number;
}

export interface RealmInfo {
  id: string;
  name: RealmName;
  label: string;
  color: string;
  status: 'online' | 'offline' | 'degraded';
}

export interface SubscriptionEdge {
  fromRealm: RealmName;
  toRealm: RealmName;
  signalId: string;
  signalLabel: string;
}

export interface DebugEvent {
  id: string;
  type: string;
  detail: string;
  at: number;
}

export interface AudienceMemberSnapshot {
  id: string;
  label: string;
  energy: number;
}

export interface VoteBucketSnapshot {
  id: string;
  label: string;
  votes: number;
}

export interface SessionCheckpointSnapshot {
  id: string;
  label: string;
  capturedAt: number;
}

export interface OrchestraEventSnapshot {
  id: string;
  type: string;
  message: string;
  atBeat: number;
}

export interface PerformerApi {
  id: Signal<string>;
  label: Signal<string>;
  color: Signal<string>;
  instrument: Signal<string>;
  confidence: Signal<number>;
  lastHitAt: Signal<number>;
  accent(): Promise<void>;
}

export interface SectionApi {
  id: Signal<string>;
  name: Signal<string>;
  energy: Signal<number>;
  density: Signal<number>;
  active: Signal<boolean>;
  performers: Signal<PerformerApi[]>;
  patternPreview: Signal<number[]>;
  mute(): Promise<void>;
  unmute(): Promise<void>;
  mutate(energyBias: number): Promise<void>;
}

export interface MotifApi {
  id: Signal<string>;
  kind: Signal<MotifKind>;
  score: Signal<number>;
  shape: Signal<number[]>;
  status: Signal<MotifStatus>;
  adopt(): Promise<void>;
  discard(): Promise<void>;
}

export interface OrchestraApi {
  id: Signal<string>;
  tempo: Signal<number>;
  beat: Signal<number>;
  phase: Signal<OrchestraPhase>;
  tension: Signal<number>;
  sections: Signal<SectionApi[]>;
  motifs: Signal<MotifApi[]>;
  eventLog: Signal<OrchestraEventSnapshot[]>;
  streamText: Signal<string>;
  seed(theme: string): Promise<void>;
  dropBeat(seed: string): Promise<void>;
  setTempo(next: number): Promise<void>;
  promoteMotif(motifId: string): Promise<void>;
  solo(sectionId: string): Promise<void>;
  freeze(): Promise<void>;
  rewindTo(bar: number): Promise<void>;
}

export interface ClusterApi {
  id: Signal<string>;
  label: Signal<string>;
  mass: Signal<number>;
  position: Signal<[number, number, number]>;
  velocity: Signal<[number, number, number]>;
  heat: Signal<number>;
  pin(): Promise<void>;
}

export interface BurstApi {
  id: Signal<string>;
  kind: Signal<string>;
  strength: Signal<number>;
  origin: Signal<[number, number, number]>;
  life: Signal<number>;
}

export interface VisualSceneApi {
  id: Signal<string>;
  cameraMood: Signal<CameraMood>;
  entropy: Signal<number>;
  palette: Signal<Palette>;
  bursts: Signal<BurstApi[]>;
  clusters: Signal<ClusterApi[]>;
  trails: Signal<number[]>;
  fpsHint: Signal<number>;
  debugStats: Signal<SimulationDebugStats>;
  igniteFromMotif(motifId: string): Promise<void>;
  focusSection(sectionId: string): Promise<void>;
  collapse(): Promise<void>;
  stabilize(): Promise<void>;
}

export interface SessionApi {
  id: Signal<string>;
  roomId: Signal<string>;
  title: Signal<string>;
  phase: Signal<SessionPhase>;
  connectedClients: Signal<number>;
  directorNote: Signal<string>;
  history: Signal<SessionCheckpointSnapshot[]>;
  start(theme: string): Promise<void>;
  freezeDrop(): Promise<void>;
  resume(): Promise<void>;
  rewind(checkpointId: string): Promise<void>;
}

export interface AudienceApi {
  id: Signal<string>;
  globalTheme: Signal<string>;
  votes: Signal<VoteBucketSnapshot[]>;
  presence: Signal<AudienceMemberSnapshot[]>;
  energy: Signal<number>;
  vote(bucketId: string): Promise<void>;
  setTheme(next: string): Promise<void>;
}

export interface DebugHubApi {
  id: Signal<string>;
  realms: Signal<RealmInfo[]>;
  subscriptions: Signal<SubscriptionEdge[]>;
  transportStats: Signal<TransportStats>;
  lastEvents: Signal<DebugEvent[]>;
  selectedSignal: Signal<string | null>;
  selectSignal(id: string): Promise<void>;
  toggleOverlay(): Promise<void>;
}

export interface OrchestraRootApi {
  orchestra: OrchestraApi;
  visuals: VisualSceneApi;
  session: SessionApi;
  audience: AudienceApi;
  debug: DebugHubApi;
}
