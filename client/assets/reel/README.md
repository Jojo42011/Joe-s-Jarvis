# Reel background music (optional)

Drop a licensed / royalty-free audio track here as **`music.mp3`** and every
reel Paulie renders will get it mixed in automatically (looped to the clip
length, gently faded in/out, at a background level).

- No file here → reels render **silent** (still valid; viewers can add audio in
  the Instagram app). Nothing breaks.
- Override the path with the `ARLO_REEL_AUDIO` env var if you keep the track
  elsewhere.
- Use only music you have the rights to post commercially (royalty-free / CC0 /
  licensed). Do not use copyrighted tracks — Instagram will mute or block them.

The renderer always tries the encode *with* music first and falls back to a
silent encode if muxing fails, so a bad file can never block publishing.
