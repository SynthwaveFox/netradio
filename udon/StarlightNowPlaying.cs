// StarlightNowPlaying.cs — UdonSharp
//
// Shows the radio's current artist / title (and optional progress) on a world UI element,
// by polling the station's /now.txt endpoint with VRCStringDownloader.
//
// Setup
//   1. Put this script on a GameObject in your scene (UdonSharpBehaviour).
//   2. Set `url` in the inspector to:  https://radio.snfx.dev/now.txt?delay=hls
//      `delay=hls` makes the server report what an HLS listener is hearing *now*, instead of
//      the live playhead, which runs ~24 s ahead of the audio people actually hear.
//   3. Assign the TextMeshProUGUI fields you want filled. Any of them may be left empty.
//
// Notes
//   - VRChat allows one string download every 5 seconds per world; `pollSeconds` is clamped
//     to 5 and defaults to 10. Position is interpolated locally between polls, so the
//     progress text still ticks every frame without extra requests.
//   - radio.snfx.dev is not on VRChat's trusted-string list, so viewers need
//     "Allow Untrusted URLs" enabled — the same setting the stream audio already needs.
//   - Values arrive as `key=value`, one per line. Unknown keys are ignored, so the server
//     can add fields later without breaking this script.

using UdonSharp;
using UnityEngine;
using UnityEngine.UI;
using TMPro;
using VRC.SDK3.StringLoading;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]   // each client polls for itself; nothing to sync
public class StarlightNowPlaying : UdonSharpBehaviour
{
    [Header("Station")]
    [Tooltip("https://your-domain/now.txt?delay=hls")]
    public VRCUrl url;

    [Tooltip("Seconds between requests. VRChat's limit is one string per 5 seconds.")]
    public float pollSeconds = 10f;

    [Header("UI (all optional)")]
    public TextMeshProUGUI displayText;    // "Artist - Title"
    public TextMeshProUGUI artistText;
    public TextMeshProUGUI titleText;
    public TextMeshProUGUI nextText;       // "Up next: ..."
    public TextMeshProUGUI progressText;   // "1:24 / 3:48"
    public TextMeshProUGUI listenersText;  // "3 listening"
    public TextMeshProUGUI playlistText;   // e.g. "Halloween Spooktacular"
    public Image progressBar;              // optional fill image (set Image Type = Filled)

    [Header("Text shown when a bumper or station ID is playing")]
    public string bumperLabel = "Starlight Radio";

    [Header("Cues (synced world events)")]
    [Tooltip("Animators to trigger when a cue fires. Add as many props as you like.")]
    public Animator[] cueAnimators;
    [Tooltip("Trigger parameter name, the same on every animator listed above.")]
    public string cueAnimatorTrigger = "RadioCue";
    [Tooltip("Behaviours to notify as well as / instead of the animators.")]
    public UdonSharpBehaviour[] cueTargets;
    public string cueTargetEvent = "OnRadioCue";
    [Tooltip("Optional global gate: ignore every cue except this one. Normally leave it EMPTY and let each receiver pick its own cue, so one poller can serve them all.")]
    public string onlyCueNamed = "";

    [Header("Long titles")]
    [Tooltip("Optional marquee for long titles. Leave off if the TextMeshPro component already handles overflow.")]
    public bool scrollLongTitles = false;
    [Tooltip("Roughly how many characters fit on one line of your UI.")]
    public int maxCharacters = 28;
    public float scrollCharsPerSecond = 4f;
    [Tooltip("Separator shown between the end and the start while scrolling.")]
    public string scrollSeparator = "   ---   ";

    private string _displayFull = "";
    private string _scrollSource = "";
    private string _lastCueId = "";
    private string _pendingCueName = "";
    private float _requestStart;
    private float _position;
    private float _duration;
    private float _positionAtTime;         // Time.time when _position was received
    private bool _playing;

    void Start()
    {
        if (pollSeconds < 5f) pollSeconds = 5f;
        Poll();
    }

    public void Poll()
    {
        if (url == null || url.Get().Length == 0)
        {
            SetText(displayText, "No URL set");
        }
        else
        {
            _requestStart = Time.time;
            VRCStringDownloader.LoadUrl(url, (IUdonEventReceiver)this);
        }
        SendCustomEventDelayedSeconds(nameof(Poll), pollSeconds);
    }

    public override void OnStringLoadSuccess(IVRCStringDownload result)
    {
        Apply(result.Result);
    }

    public override void OnStringLoadError(IVRCStringDownload result)
    {
        Debug.LogWarning("[NowPlaying] load failed: " + result.ErrorCode + " " + result.Error);
        // Leave the last known values on screen rather than blanking the UI.
    }

    private void Apply(string body)
    {
        string kind = "";
        string artist = "";
        string title = "";
        string display = "";
        string next = "";
        string listeners = "";
        string playlist = "";
        string cueName = "";
        string cueId = "";
        float cueIn = 0f;
        bool haveCueIn = false;
        float position = 0f;
        float duration = 0f;

        string[] lines = body.Split('\n');
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i].Trim();
            if (line.Length == 0) continue;
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string key = line.Substring(0, eq);
            string value = line.Substring(eq + 1);

            if (key == "kind") kind = value;
            else if (key == "artist") artist = value;
            else if (key == "title") title = value;
            else if (key == "display") display = value;
            else if (key == "next") next = value;
            else if (key == "listeners") listeners = value;
            else if (key == "playlist") playlist = value;
            else if (key == "cue") cueName = value;
            else if (key == "cueId") cueId = value;
            else if (key == "cueIn") haveCueIn = float.TryParse(value, out cueIn);
            else if (key == "position") float.TryParse(value, out position);
            else if (key == "duration") float.TryParse(value, out duration);
        }

        bool isSong = kind == "song";
        _playing = isSong;
        _position = position;
        _duration = duration;
        _positionAtTime = Time.time;

        _displayFull = isSong ? display : bumperLabel;
        _scrollSource = _displayFull + scrollSeparator;
        SetText(displayText, _displayFull);
        SetText(artistText, isSong ? artist : "");
        SetText(titleText, isSong ? title : bumperLabel);
        SetText(nextText, next.Length > 0 ? "Up next: " + next : "");
        SetText(listenersText, listeners.Length > 0 ? listeners + " listening" : "");
        SetText(playlistText, playlist);
        HandleCue(cueName, cueId, cueIn, haveCueIn);
        UpdateProgress();
    }

    // The server reports a cue before anyone hears it, counting down in listener time.
    // Each client schedules its own timer off that number, so everyone fires together and
    // in time with the audio they are actually hearing. Polling alone could never be
    // tight enough (one request per 5 s), which is why this schedules rather than reacts.
    private void HandleCue(string cueName, string cueId, float cueIn, bool haveCueIn)
    {
        if (cueId.Length == 0 || cueId == _lastCueId) return;          // nothing new
        if (onlyCueNamed.Length > 0 && cueName != onlyCueNamed) return;
        _lastCueId = cueId;                                            // claim it either way
        if (!haveCueIn) return;

        // Half the round trip is the server's view aging on the way to us.
        float latency = Mathf.Clamp((Time.time - _requestStart) * 0.5f, 0f, 2f);
        float wait = cueIn - latency;
        if (wait <= 0f)
        {
            Debug.Log("[NowPlaying] cue '" + cueName + "' already passed (" + cueIn + "s), skipping");
            return;
        }
        _pendingCueName = cueName;
        SendCustomEventDelayedSeconds(nameof(FireCue), wait);
        Debug.Log("[NowPlaying] cue '" + cueName + "' scheduled in " + wait + "s");
    }

    public void FireCue()
    {
        int animators = 0;
        if (cueAnimators != null && cueAnimatorTrigger.Length > 0)
        {
            for (int i = 0; i < cueAnimators.Length; i++)
            {
                if (cueAnimators[i] == null) continue;
                cueAnimators[i].SetTrigger(cueAnimatorTrigger);
                animators++;
            }
        }
        int targets = 0;
        if (cueTargets != null && cueTargetEvent.Length > 0)
        {
            for (int i = 0; i < cueTargets.Length; i++)
            {
                if (cueTargets[i] == null) continue;
                // Hand the receiver the cue name so it can decide for itself. A receiver
                // without a `radioCue` field simply ignores this.
                cueTargets[i].SetProgramVariable("radioCue", _pendingCueName);
                cueTargets[i].SendCustomEvent(cueTargetEvent);
                targets++;
            }
        }
        Debug.Log("[NowPlaying] cue '" + _pendingCueName + "' fired -> " + animators + " animators, " + targets + " behaviours");
    }

    void Update()
    {
        UpdateProgress();
        UpdateScroll();
    }

    // Character-window marquee: no layout measuring, so it behaves the same on every rig.
    private void UpdateScroll()
    {
        if (displayText == null || !scrollLongTitles) return;
        if (_displayFull.Length <= maxCharacters)
        {
            if (displayText.text != _displayFull) displayText.text = _displayFull;
            return;
        }

        int len = _scrollSource.Length;
        int offset = (int)(Time.time * scrollCharsPerSecond) % len;
        string window;
        if (offset + maxCharacters <= len)
        {
            window = _scrollSource.Substring(offset, maxCharacters);
        }
        else
        {
            string tail = _scrollSource.Substring(offset);
            window = tail + _scrollSource.Substring(0, maxCharacters - tail.Length);
        }
        displayText.text = window;
    }

    private void UpdateProgress()
    {
        if (progressText == null && progressBar == null) return;

        if (!_playing || _duration <= 0f)
        {
            SetText(progressText, "");
            if (progressBar != null) progressBar.fillAmount = 0f;
            return;
        }

        float p = _position + (Time.time - _positionAtTime);
        if (p > _duration) p = _duration;
        if (p < 0f) p = 0f;

        SetText(progressText, Clock(p) + " / " + Clock(_duration));
        if (progressBar != null) progressBar.fillAmount = p / _duration;
    }

    private string Clock(float seconds)
    {
        int total = (int)seconds;
        int m = total / 60;
        int s = total % 60;
        return m + ":" + (s < 10 ? "0" : "") + s;
    }

    private void SetText(TextMeshProUGUI target, string value)
    {
        if (target != null) target.text = value;
    }
}
