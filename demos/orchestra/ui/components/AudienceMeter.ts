import type {OrchestraRootApi} from '../../shared/types.ts';

export function createAudienceMeterView(root: OrchestraRootApi) {
  return {
    kind: 'audience-meter' as const,
    async vote(bucketId: string) {
      await root.audience.vote(bucketId);
    },
    getSnapshot() {
      return {
        energy: root.audience.energy.value,
        theme: root.audience.globalTheme.value,
        votes: root.audience.votes.value,
      };
    },
  };
}
