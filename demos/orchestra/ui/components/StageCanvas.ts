import type {OrchestraRootApi} from '../../shared/types.ts';

export function createStageCanvasView(root: OrchestraRootApi) {
  return {
    kind: 'stage-canvas' as const,
    getSnapshot() {
      return {
        phase: root.orchestra.phase.value,
        cameraMood: root.visuals.cameraMood.value,
        entropy: root.visuals.entropy.value,
        motifCount: root.orchestra.motifs.value.length,
      };
    },
  };
}
