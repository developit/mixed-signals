import {VisualScene} from './models.ts';

export interface VisualRoot {
  visuals: VisualScene;
}

export function createVisualRoot(): VisualRoot {
  return {
    visuals: new VisualScene(),
  };
}
