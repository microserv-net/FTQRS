# Transmitter

Static site. Serve it over https:// (or localhost) and open `index.html`.

    python3 -m http.server 8000

Pick a file, check the estimate, press **Start transmitting**. The stream never
ends — keep it running until the receiver says it is done, then press **Stop**.

Controls while transmitting: `space` pauses, `f` fills the screen, `esc` leaves
fullscreen. The speed slider is live; lowering it costs nothing.

Settings worth knowing:

- **Data per frame** — the single biggest lever. 300 B suits most phones. Drop
  to 120 B for a small or dim screen, an older camera, or a longer distance.
- **Frames per second** — faster is only faster if the receiver keeps up.
  Frames it misses are not wasted, but they are not progress either. Start at
  10 and watch the receiver's "still missing" count.
- **Error correction** — higher survives glare and fingerprints at the cost of
  a denser code.
- **Encrypt with a password** — AES-256-GCM before chunking. The receiver is
  prompted for the same password after the file verifies.

Nothing is uploaded. The file is read locally and exists only as light.
