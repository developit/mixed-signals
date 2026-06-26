---
"mixed-signals": minor
---

Add process-aware reconnect support that keeps client roots, signals, and reflected model facades alive across transport replacement, refreshes them from the next root snapshot, replays active signal subscriptions, treats missing connection metadata as an unknown process for legacy servers, and exposes server connection metadata for process identity and retained-state resumes.
