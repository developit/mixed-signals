import {Orchestra} from './models.ts';

export interface AudioRoot {
  orchestra: Orchestra;
}

export function createAudioRoot(): AudioRoot {
  return {
    orchestra: new Orchestra(),
  };
}
