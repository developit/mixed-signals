---
"mixed-signals": patch
---

Unwatching a signal now discards its last-sent value and the client's saved model state on the server.
The next watch sends a full value, and affected models include their fields when sent again.
