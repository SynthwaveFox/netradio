// HijackFade.cs — UdonSharp
//
// Blacks the view out instantly and fades it back, using a single small sphere that
// follows the local player's head. Far cheaper than swapping every renderer in the world:
// one object, one material, one colour change per frame while fading, and nothing at all
// when idle. It also covers the skybox, which a material swap cannot.
//
// Scene setup
//   1. GameObject → 3D Object → Sphere. Scale it to about 0.5 (so the camera sits inside).
//      Remove its Collider.
//   2. Material: shader **UI/Default**, colour black. That shader is unlit, transparent and
//      Cull Off, so the sphere is visible from the inside and ignores all lighting.
//   3. Put this script on the sphere. Leave `fadeRenderer` empty to use its own Renderer.
//   4. On StarlightNowPlaying: add this to `Cue Targets`, `Cue Target Event` = OnRadioCue.
//
// Timing
//   cue -> fully black for `holdSeconds` -> fades out over `fadeSeconds` -> renderer off.
//   Set `holdSeconds` to 0 for an immediate fade back.
//
// Notes
//   - Every client runs this itself off the same server cue, so it stays in sync without
//     any networking. The sphere sits on each player's own head; it is not shared.
//   - The sphere will show up in mirrors and on cameras. If that bothers you, put it on a
//     layer your mirrors do not render.
//   - This darkens everything uniformly. If you want the "baked light is gone but realtime
//     light remains" look instead, that is HijackBlackout.cs with an unlit material.

using UdonSharp;
using UnityEngine;
using VRC.SDKBase;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class HijackFade : UdonSharpBehaviour
{
    [Header("Setup")]
    [Tooltip("Leave empty to use the Renderer on this object.")]
    public Renderer fadeRenderer;
    [Tooltip("Colour property on the material. UI/Default and most unlit shaders use _Color.")]
    public string colorProperty = "_Color";
    [Tooltip("Keep the sphere on the local player's head. Turn off if you have parented it yourself.")]
    public bool followHead = true;
    [Tooltip("Resize the sphere with the player. VRChat scales the camera's near clip with avatar height, so a fixed size can fall inside the near plane on a very large avatar and disappear.")]
    public bool scaleWithAvatar = true;
    [Tooltip("Sphere radius as a fraction of eye height. 0.15 gives ~0.24 m at a normal 1.6 m eye height.")]
    public float radiusPerEyeHeight = 0.15f;
    [Tooltip("Never go below this radius in metres, however small the avatar.")]
    public float minRadius = 0.08f;

    [Header("Timing")]
    [Tooltip("Seconds to fade INTO black when the cue fires. 0 = instant cut to black.")]
    public float fadeInSeconds = 1f;
    [Tooltip("Seconds held fully black once it has faded in.")]
    public float holdSeconds = 1.5f;
    [Tooltip("Seconds to fade from black back to clear.")]
    public float fadeSeconds = 3f;
    [Tooltip("How dark it gets. 1 = fully black, lower = a dimming rather than a blackout.")]
    [Range(0f, 1f)]
    public float peakAlpha = 1f;

    private Material _mat;
    private Color _color = Color.black;
    private float _alpha;
    private float _started = -1f;
    private bool _active;

    void Start()
    {
        if (fadeRenderer == null) fadeRenderer = (Renderer)GetComponent(typeof(Renderer));
        if (fadeRenderer == null)
        {
            Debug.LogError("[HijackFade] no Renderer — put this on the sphere or set fadeRenderer");
            return;
        }
        _mat = fadeRenderer.material;      // one instance on one object; cheap
        _color = _mat.GetColor(colorProperty);
        SetAlpha(0f);
        fadeRenderer.enabled = false;
        Debug.Log("[HijackFade] ready");
    }

    [Header("Which cue")]
    [Tooltip("Set by StarlightNowPlaying just before it calls OnRadioCue. Do not edit.")]
    [HideInInspector] public string radioCue = "";
    [Tooltip("React only to this cue name. Empty = react to every cue.")]
    public string onlyCueNamed = "";

    // Called by StarlightNowPlaying at the exact moment listeners hear the cue.
    public void OnRadioCue()
    {
        if (onlyCueNamed.Length > 0 && radioCue != onlyCueNamed) return;
        if (_mat == null) return;
        _started = Time.time;
        _active = true;
        fadeRenderer.enabled = true;
        SetAlpha(fadeInSeconds > 0f ? 0f : peakAlpha);
    }

    // Stop early and clear the screen.
    public void ClearNow()
    {
        _active = false;
        SetAlpha(0f);
        if (fadeRenderer != null) fadeRenderer.enabled = false;
    }

    void LateUpdate()
    {
        if (followHead && fadeRenderer != null && fadeRenderer.enabled)
        {
            VRCPlayerApi p = Networking.LocalPlayer;
            if (p != null)
            {
                // Head tracking data is the viewpoint, so avatar head shape is irrelevant.
                // LateUpdate so the sphere lands on this frame's position, not last frame's.
                transform.position = p.GetTrackingData(VRCPlayerApi.TrackingDataType.Head).position;

                if (scaleWithAvatar)
                {
                    float eyes = p.GetAvatarEyeHeightAsMeters();
                    if (eyes <= 0f) eyes = 1.6f;
                    float radius = eyes * radiusPerEyeHeight;
                    if (radius < minRadius) radius = minRadius;
                    float d = radius * 2f;                 // the primitive sphere is 1 unit across
                    transform.localScale = new Vector3(d, d, d);
                }
            }
        }

        if (!_active) return;

        // fade in -> hold -> fade out
        float since = Time.time - _started;

        if (since < fadeInSeconds)
        {
            SetAlpha(peakAlpha * (since / fadeInSeconds));
            return;
        }
        float afterIn = since - fadeInSeconds;
        if (afterIn < holdSeconds)
        {
            SetAlpha(peakAlpha);
            return;
        }
        if (fadeSeconds <= 0f)
        {
            ClearNow();
            return;
        }
        float t = (afterIn - holdSeconds) / fadeSeconds;
        if (t >= 1f)
        {
            ClearNow();
            return;
        }
        SetAlpha(peakAlpha * (1f - t));
    }

    private void SetAlpha(float a)
    {
        _alpha = a;
        if (_mat == null) return;
        _color.a = a;
        _mat.SetColor(colorProperty, _color);
    }
}
