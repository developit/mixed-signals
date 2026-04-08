import type {OrchestraRootApi} from '../../shared/types.ts';

export function createSectionListView(root: OrchestraRootApi) {
  return {
    kind: 'section-list' as const,
    async solo(sectionId: string) {
      await root.orchestra.solo(sectionId);
    },
    getSnapshot() {
      return root.orchestra.sections.value.map((section) => ({
        id: section.id.value,
        name: section.name.value,
        active: section.active.value,
        energy: section.energy.value,
      }));
    },
  };
}
