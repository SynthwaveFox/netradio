# Minimal continuous radio for Icecast using Liquidsoap
# Features:
# - shuffled songs
# - random bumper before each song
# - one continuous live stream to Icecast

set("log.stdout", true)
set("server.telnet", false)

songs_dir = "/mnt/c/Users/soude/vscProjects/radio-server/songs"
bumpers_dir = "/mnt/c/Users/soude/vscProjects/radio-server/intros/generic"

songs = playlist(mode="randomize", reload_mode="watch", songs_dir)
bumpers = playlist(mode="randomize", reload_mode="watch", bumpers_dir)
radio_core = rotate(weights=[1, 1], [bumpers, songs])
radio = fallback(track_sensitive=false, [radio_core, blank()])
radio = normalize(radio)
radio = amplify(0.35, radio)

output.icecast(
  %mp3(bitrate=192, stereo=true),
  host = "127.0.0.1",
  port = 8000,
  password = "hackme",
  mount = "radio.mp3",
  name = "Gizmo Radio",
  description = "Continuous shuffled songs with random bumpers",
  genre = "Mixed",
  public = false,
  radio
)
