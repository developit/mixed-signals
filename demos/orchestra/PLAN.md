# The Impossible Orchestra

A multi-realm demo for `mixed-signals` that makes remote Signals and Models feel local while preserving strict ownership boundaries.

## Thesis

The demo should prove that `mixed-signals` lets us put state where it belongs:
- audio logic in an audio worker,
- visual simulation in a visual worker,
- shared session/audience/debug state in a broker/server,
- rendering in the main thread,

…while the UI still consumes a single coherent reactive model tree.

## Value proposition to showcase

- Signals reflect across transports and remain live.
- Methods can execute in the realm that owns the model.
- Multiple upstream roots can merge into one downstream root.
- Reactivity doubles as the subscription protocol: inactive UI should not cost updates.
- The app should require dramatically less glue than equivalent postMessage/event-bus architectures.

## Demo concept

A live, multiplayer audiovisual orchestra made of multiple JavaScript realms:
- **UI realm**: stage, controls, overlay, inspector
- **Audio worker**: rhythm/composition/timing engine
- **Visual worker**: particle/simulation engine
- **Broker/server**: conductor/session/audience/debug hub

The user draws or generates motifs. Music mutates. Visuals bloom. Audience tabs vote on mood. A realm overlay reveals that the app is one reactive surface stitched from several independently-owned brains.

## Realm ownership

### UI realm
Owns only local ephemeral UI state:
- active panel
- pointer/drag state
- local hover selection

Consumes everything else as reflected models/signals.

### Audio worker
Owns time and composition:
- tempo
- beat
- sections
- motifs
- event log
- streamed conductor text

### Visual worker
Owns space and motion:
- camera mood
- clusters
- bursts
- trails
- debug stats for simulation

### Broker/server
Owns composition and shared coordination:
- session lifecycle
- audience voting / theme
- presence
- debug/realm overlay data
- upstream composition via `addUpstream()`

## Top-level merged root

```ts
{
  orchestra,
  visuals,
  session,
  audience,
  debug,
}
```

## Schema overview

### Audio realm

#### Orchestra
Signals:
- `tempo`
- `beat`
- `phase`
- `tension`
- `sections`
- `motifs`
- `eventLog`
- `streamText`

Methods:
- `seed(theme)`
- `dropBeat(seed)`
- `setTempo(next)`
- `promoteMotif(motifId)`
- `solo(sectionId)`
- `freeze()`
- `rewindTo(bar)`

#### Section
Signals:
- `name`
- `energy`
- `density`
- `active`
- `performers`
- `patternPreview`

Methods:
- `mute()`
- `unmute()`
- `mutate(energyBias)`

#### Performer
Signals:
- `label`
- `color`
- `instrument`
- `confidence`
- `lastHitAt`

Methods:
- `accent()`

#### Motif
Signals:
- `kind`
- `score`
- `shape`
- `status`

Methods:
- `adopt()`
- `discard()`

### Visual realm

#### VisualScene
Signals:
- `cameraMood`
- `entropy`
- `palette`
- `bursts`
- `clusters`
- `trails`
- `fpsHint`
- `debugStats`

Methods:
- `igniteFromMotif(motifId)`
- `focusSection(sectionId)`
- `collapse()`
- `stabilize()`

#### Cluster
Signals:
- `label`
- `mass`
- `position`
- `velocity`
- `heat`

Methods:
- `pin()`

#### Burst
Signals:
- `kind`
- `strength`
- `origin`
- `life`

### Broker realm

#### Session
Signals:
- `roomId`
- `title`
- `phase`
- `connectedClients`
- `directorNote`
- `history`

Methods:
- `start(theme)`
- `freezeDrop()`
- `resume()`
- `rewind(checkpointId)`

#### Audience
Signals:
- `globalTheme`
- `votes`
- `presence`
- `energy`

Methods:
- `vote(bucketId)`
- `setTheme(next)`

#### DebugHub
Signals:
- `realms`
- `subscriptions`
- `transportStats`
- `lastEvents`
- `selectedSignal`

Methods:
- `selectSignal(id)`
- `toggleOverlay()`

## Protocol-aware data-shape guidance

Prefer shapes that match the existing wire protocol strengths:
- append-friendly arrays for logs/history/bursts where possible,
- string append for streamed conductor text,
- object merge for stats/palette snapshots,
- reserve full replacement for coarse-grained structures.

## File/folder scaffold

```text
demos/orchestra/
  AGENTS.md
  PLAN.md
  README.md
  shared/
    types.ts
    transports.ts
  audio/
    models.ts
    root.ts
    worker.ts
  visual/
    models.ts
    root.ts
    worker.ts
  broker/
    models.ts
    root.ts
    orchestration.ts
    index.ts
  ui/
    models.ts
    rpc.ts
    app.ts
    components/
      StageCanvas.ts
      ConductorPanel.ts
      AudienceMeter.ts
      RealmOverlay.ts
      EventLog.ts
      SectionList.ts
```

## Milestones

### Milestone 1: one magical slice
Build the minimum loop:
- audio worker exposed via `mixed-signals`
- broker forwarding/merging in place
- UI connects to broker
- user creates a motif
- orchestra event log and conductor text update reactively

### Milestone 2: visual worker
Add visual worker and merge it into the broker root.
- one user action should affect both `orchestra` and `visuals`
- UI should still read from one merged root

### Milestone 3: session + debug overlay
Add broker-owned models for:
- audience
- session
- debug transport stats / realm inspector

### Milestone 4: second client/tab
Allow a second tab to vote on energy/theme and change the same live session.

### Milestone 5: hardening and polish
- reconnect/restart worker live
- improve visual language
- tune transport payloads
- prune unnecessary abstractions

## Implementation principles

- Prototype first. Do not start with a general-purpose framework.
- Tighten boundaries after the first vertical slice works.
- UI code can stay relaxed and direct.
- Critical paths live in worker-local code and only expose the minimum observable surface.
- Keep orchestration explicit and centralized in broker code.

## Non-goals for the first follow-up step

- perfect visuals
- production audio engine
- generalized replay system
- code generation
- custom protocol layer over `mixed-signals`

## First follow-up implementation target

Implement a runnable milestone with:
- broker + audio worker + UI
- reflected `Orchestra`, `Section`, `Motif`
- one working action (`seed` or `dropBeat`)
- event log + stream text + section list
- basic realm overlay showing ownership labels
