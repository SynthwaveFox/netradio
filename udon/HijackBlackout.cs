// HijackBlackout.cs — UdonSharp
//
// Swaps every renderer under the given roots to one flat unlit material and back, which
// gives the "baked lighting is gone, everything is a silhouette" look. Udon cannot touch
// lightmaps (VRChat does not expose LightmapSettings), but an unlit shader never samples
// them, so swapping the material achieves the same thing.
//
// Setup
//   1. Make a material: Shader = Unlit/Color, Color = black. Assign it to `blackMaterial`.
//   2. Put the world geometry you want affected under one or more parents and drag those
//      into `includeRoots`. Anything that must stay visible (the radio UI, a prop that is
//      meant to glow) goes in `exclude`.
//   3. On StarlightNowPlaying, add this behaviour to `Cue Targets` and set
//      `Cue Target Event` to OnRadioCue.
//
// Timing
//   `toggleTimes` is a list of seconds measured from the cue; each entry flips the state.
//   So 0, 0.1, 0.25, 0.4, 3.0 gives two quick blips and then three seconds of black before
//   coming back. Leave it empty to just black out for `blackoutSeconds`.
//
// Notes
//   - Every client runs this itself off the same server cue, so it stays in sync without
//     any networking.
//   - Renderers are collected once at Start. Objects spawned later are not included.
//   - Swapping materials on statically batched geometry can drop it out of its batch for
//     the duration. Fine for a short effect; do not leave the world black for hours.

using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class HijackBlackout : UdonSharpBehaviour
{
    [Header("What goes black")]
    [Tooltip("Every renderer under these transforms is affected.")]
    public Transform[] includeRoots;
    [Tooltip("Renderers listed here are left alone.")]
    public Renderer[] exclude;
    [Tooltip("Unlit/Color, black. Unlit is the point: it ignores baked lighting.")]
    public Material blackMaterial;
    [Tooltip("Objects switched on only while black. A material swap cannot touch the skybox, so put a big inverted black sphere here if the sky would show. Glitch overlays go here too.")]
    public GameObject[] showWhileBlack;

    [Header("Timing")]
    [Tooltip("Seconds of black when toggleTimes is empty. 0 = stay until Restore() is called.")]
    public float blackoutSeconds = 3f;
    [Tooltip("Seconds from the cue; each entry flips between black and normal.")]
    public float[] toggleTimes;

    [Header("Coming back")]
    [Tooltip("Seconds over which renderers return, a few at a time, like power coming back. 0 = everything snaps back at once.")]
    public float restoreSeconds = 2.5f;
    [Tooltip("Return them in a random order. Off = the order they were collected, which tends to sweep by hierarchy.")]
    public bool restoreRandomOrder = true;

    private Renderer[] _renderers;
    private Material[][] _original;
    private int[] _order;
    private bool _black;
    private bool _ready;
    private bool _restoring;
    private float _restoreStart;
    private int _restoredCount;

    void Start()
    {
        int count = 0;
        if (includeRoots != null)
        {
            for (int r = 0; r < includeRoots.Length; r++)
            {
                if (includeRoots[r] == null) continue;
                Renderer[] found = includeRoots[r].GetComponentsInChildren<Renderer>(true);
                for (int i = 0; i < found.Length; i++) if (!IsExcluded(found[i])) count++;
            }
        }

        _renderers = new Renderer[count];
        _original = new Material[count][];
        int n = 0;
        if (includeRoots != null)
        {
            for (int r = 0; r < includeRoots.Length; r++)
            {
                if (includeRoots[r] == null) continue;
                Renderer[] found = includeRoots[r].GetComponentsInChildren<Renderer>(true);
                for (int i = 0; i < found.Length; i++)
                {
                    if (IsExcluded(found[i])) continue;
                    _renderers[n] = found[i];
                    _original[n] = found[i].sharedMaterials;   // cache so we can put it all back
                    n++;
                }
            }
        }
        _ready = (blackMaterial != null && n > 0) || (showWhileBlack != null && showWhileBlack.Length > 0);
        Debug.Log("[HijackBlackout] watching " + n + " renderers, ready=" + _ready);
    }

    private bool IsExcluded(Renderer r)
    {
        if (r == null) return true;
        if (exclude == null) return false;
        for (int i = 0; i < exclude.Length; i++) if (exclude[i] == r) return true;
        return false;
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
        if (!_ready) return;
        if (toggleTimes != null && toggleTimes.Length > 0)
        {
            for (int i = 0; i < toggleTimes.Length; i++)
            {
                SendCustomEventDelayedSeconds(nameof(ToggleBlack), Mathf.Max(0f, toggleTimes[i]));
            }
            return;
        }
        Blackout();
        if (blackoutSeconds > 0f) SendCustomEventDelayedSeconds(nameof(Restore), blackoutSeconds);
    }

    public void ToggleBlack()
    {
        if (_black) Restore(); else Blackout();
    }

    public void Blackout()
    {
        if (!_ready) return;
        _restoring = false;              // cancel a restore that is still running
        if (_black) return;
        for (int i = 0; i < _renderers.Length; i++)
        {
            if (_renderers[i] == null) continue;
            int slots = _original[i].Length;
            Material[] swap = new Material[slots < 1 ? 1 : slots];
            for (int m = 0; m < swap.Length; m++) swap[m] = blackMaterial;
            _renderers[i].sharedMaterials = swap;
        }
        SetExtras(true);
        _black = true;
    }

    private void SetExtras(bool on)
    {
        if (showWhileBlack == null) return;
        for (int i = 0; i < showWhileBlack.Length; i++)
        {
            if (showWhileBlack[i] != null) showWhileBlack[i].SetActive(on);
        }
    }

    public void Restore()
    {
        if (!_ready || !_black) return;
        if (restoreSeconds <= 0f)
        {
            RestoreAll();
            return;
        }
        // Come back a few renderers at a time rather than all in one frame.
        BuildOrder();
        _restoredCount = 0;
        _restoreStart = Time.time;
        _restoring = true;
    }

    private void RestoreAll()
    {
        for (int i = 0; i < _renderers.Length; i++)
        {
            if (_renderers[i] == null) continue;
            _renderers[i].sharedMaterials = _original[i];
        }
        SetExtras(false);
        _restoring = false;
        _black = false;
    }

    private void BuildOrder()
    {
        _order = new int[_renderers.Length];
        for (int i = 0; i < _order.Length; i++) _order[i] = i;
        if (!restoreRandomOrder) return;
        for (int i = _order.Length - 1; i > 0; i--)     // Fisher-Yates
        {
            int j = Random.Range(0, i + 1);
            int tmp = _order[i]; _order[i] = _order[j]; _order[j] = tmp;
        }
    }

    void Update()
    {
        if (!_restoring) return;
        float t = (Time.time - _restoreStart) / restoreSeconds;
        if (t > 1f) t = 1f;
        int target = Mathf.CeilToInt(t * _order.Length);
        while (_restoredCount < target)
        {
            int idx = _order[_restoredCount];
            if (_renderers[idx] != null) _renderers[idx].sharedMaterials = _original[idx];
            _restoredCount++;
        }
        if (t >= 1f)
        {
            SetExtras(false);
            _restoring = false;
            _black = false;
        }
    }
}
