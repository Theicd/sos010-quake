# SOS Quake (`sos010-quake`)

Browser Quake (Three.js port) with **one-tap Play** and **P2P multiplayer** (up to 4 players).

Live: https://theicd.github.io/sos010-quake/

## Play

1. Open the link.
2. Choose an **arena** (preview card + short blurb).
3. Tap **Play** (Team coop — players vs monsters, up to 4).
4. If someone is already in a room, you join **their** arena (spawn next to them).
5. If not, you host that arena; cool weapons & armor scatter across the map at start.

No accounts. Matchmaking uses Nostr discovery + WebRTC data channels (same approach as SOS Kart / Chess).

Top bar:

- **GitHub** (left) → upstream project
- **Download** → install / add icon to home screen or desktop
- **Gear** → original Quake options (controls, brightness, volume, …)

### Query flags

| Param | Effect |
|-------|--------|
| `?solo=1` | Skip matchmaking, start a local game |
| `?auto=1` | Press Play automatically |
| `?map=e1m1` | Force a specific host map (overrides the arena picker) |
| `?net=0` | Disable online matchmaking |
| `?relay=1` | Force TURN for WebRTC |

## Credits / upstream

This build is based on **[mrdoob/three-quake](https://github.com/mrdoob/three-quake)** (GPL-2.0) by [@mrdoob](https://github.com/mrdoob) — open the repo card / profile for the original Three.js Quake port:

- Project: https://github.com/mrdoob/three-quake  
- Author: https://github.com/mrdoob  

Original game by id Software ([Quake](https://github.com/id-Software/Quake)).

Shareware `pak0.pak` (Episode 1) is included. For the full game, replace with your own registered `pak0.pak`.

SOS adds the one-tap Play lobby, Deathmatch/Team mode selection, and Nostr+WebRTC P2P session sharing on top of that upstream engine.

## License

Code: GPL v2 (see `LICENSE`)
