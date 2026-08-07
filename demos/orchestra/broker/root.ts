import {Audience, DebugHub, Session} from './models.ts';

export interface BrokerRoot {
  session: Session;
  audience: Audience;
  debug: DebugHub;
}

export function createBrokerRoot(): BrokerRoot {
  return {
    session: new Session(),
    audience: new Audience(),
    debug: new DebugHub(),
  };
}
