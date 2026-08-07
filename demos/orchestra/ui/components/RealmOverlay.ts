import type {OrchestraRootApi} from '../../shared/types.ts';

export function createRealmOverlayView(root: OrchestraRootApi) {
  return {
    kind: 'realm-overlay' as const,
    async selectSignal(id: string) {
      await root.debug.selectSignal(id);
    },
    async toggle() {
      await root.debug.toggleOverlay();
    },
    getSnapshot() {
      return {
        realms: root.debug.realms.value,
        selectedSignal: root.debug.selectedSignal.value,
        transportStats: root.debug.transportStats.value,
      };
    },
  };
}
