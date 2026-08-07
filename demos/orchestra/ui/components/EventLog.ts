import type {OrchestraRootApi} from '../../shared/types.ts';

export function createEventLogView(root: OrchestraRootApi) {
  return {
    kind: 'event-log' as const,
    getSnapshot() {
      return {
        events: root.orchestra.eventLog.value,
        streamText: root.orchestra.streamText.value,
      };
    },
  };
}
