import type {OrchestraRootApi} from '../../shared/types.ts';

export function createConductorPanelView(root: OrchestraRootApi) {
  return {
    kind: 'conductor-panel' as const,
    async start(theme: string) {
      await root.session.start(theme);
    },
    async dropBeat(seed: string) {
      await root.orchestra.dropBeat(seed);
    },
    getSnapshot() {
      return {
        title: root.session.title.value,
        note: root.session.directorNote.value,
        text: root.orchestra.streamText.value,
        tempo: root.orchestra.tempo.value,
      };
    },
  };
}
