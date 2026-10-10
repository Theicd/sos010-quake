# SOS Quake (`sos010-quake`)

Browser Quake (Three.js port) with **one-tap Play** and **P2P multiplayer** (up to 4 players).

Live: https://theicd.github.io/sos010-quake/

## Play

1. Open the link.
2. Tap **Play**.
3. If someone is already in a room, you join their map session (spawn next to them).
4. If not, you host a deathmatch listen server and others can join.

No accounts. Matchmaking uses Nostr discovery + WebRTC data channels (same approach as SOS Kart / Chess).

### Query flags

| Param | Effect |
|-------|--------|
| `?solo=1` | Skip matchmaking, start local deathmatch |
| `?auto=1` | Press Play automatically |
| `?map=rapture1` | Host map name (default `rapture1`) |
| `?net=0` | Disable online matchmaking |
| `?relay=1` | Force TURN for WebRTC |

## Upstream

Based on [mrdoob/three-quake](https://github.com/mrdoob/three-quake) (GPL-2.0).

- Original game by id Software ([Quake](https://github.com/id-Software/Quake))
- Three.js port by [@mrdoob](https://github.com/mrdoob)

Shareware `pak0.pak` (Episode 1) is included. For the full game, replace with your own registered `pak0.pak`.

## License

Code: GPL v2 (see `LICENSE`)
