import type {BrokerRoot} from './root.ts';

export interface OrchestraUpstreams {
  orchestra?: {
    seed(theme: string): Promise<void> | void;
    dropBeat(seed: string): Promise<void> | void;
  };
  visuals?: {
    igniteFromMotif(motifId: string): Promise<void> | void;
    stabilize(): Promise<void> | void;
  };
}

export class BrokerOrchestrator {
  private root: BrokerRoot;
  private upstreams: OrchestraUpstreams;

  constructor(root: BrokerRoot, upstreams: OrchestraUpstreams) {
    this.root = root;
    this.upstreams = upstreams;
  }

  async start(theme: string) {
    this.root.session.start(theme);
    await this.upstreams.orchestra?.seed(theme);
  }

  async onAudienceEnergyPeak(seed: string) {
    await this.upstreams.orchestra?.dropBeat(seed);
  }

  async onMotifAdopted(motifId: string) {
    await this.upstreams.visuals?.igniteFromMotif(motifId);
  }

  async stabilizeVisuals() {
    await this.upstreams.visuals?.stabilize();
  }
}
