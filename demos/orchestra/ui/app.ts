import type {OrchestraRootApi} from '../shared/types.ts';
import {createAudienceMeterView} from './components/AudienceMeter.ts';
import {createConductorPanelView} from './components/ConductorPanel.ts';
import {createEventLogView} from './components/EventLog.ts';
import {createRealmOverlayView} from './components/RealmOverlay.ts';
import {createSectionListView} from './components/SectionList.ts';
import {createStageCanvasView} from './components/StageCanvas.ts';

export interface OrchestraAppView {
  stage: ReturnType<typeof createStageCanvasView>;
  conductor: ReturnType<typeof createConductorPanelView>;
  audience: ReturnType<typeof createAudienceMeterView>;
  sections: ReturnType<typeof createSectionListView>;
  events: ReturnType<typeof createEventLogView>;
  overlay: ReturnType<typeof createRealmOverlayView>;
}

export function createOrchestraApp(root: OrchestraRootApi): OrchestraAppView {
  return {
    stage: createStageCanvasView(root),
    conductor: createConductorPanelView(root),
    audience: createAudienceMeterView(root),
    sections: createSectionListView(root),
    events: createEventLogView(root),
    overlay: createRealmOverlayView(root),
  };
}
