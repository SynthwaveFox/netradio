// CueMaterialSwap.cs — UdonSharp
//
// Swaps chosen objects to their own chosen materials when one cue fires, and puts them back
// when another does. Each object gets its own replacement material — they do not share one.
//
// Setup
//   1. Empty GameObject → Add Component → Cue Material Swap.
//   2. `renderers`  — the objects to change. Set the size, drag them in.
//      `swapTo`     — same size, same order: the material each one becomes.
//      (Slot 3 of `renderers` becomes slot 3 of `swapTo`.)
//   3. `applyCue` = hijack, `restoreCue` = restore  (names from cues.json)
//   4. On StarlightNowPlaying: add this object to `Cue Targets`,
//      `Cue Target Event` = OnRadioCue, and leave the poller's own `onlyCueNamed` empty.
//
// Originals are read once at Start and put back exactly as they were, so you do not have to
// list the "normal" materials anywhere.
//
// If a renderer has several material slots, every slot is set to the swap material. Leave a
// `swapTo` entry empty to skip that renderer.

using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class CueMaterialSwap : UdonSharpBehaviour
{
    [Header("Which cues")]
    [Tooltip("Set by StarlightNowPlaying just before it calls OnRadioCue. Do not edit.")]
    [HideInInspector] public string radioCue = "";
    [Tooltip("Cue name that swaps the materials in.")]
    public string applyCue = "hijack";
    [Tooltip("Cue name that puts them back. Leave empty if you only use autoRestoreSeconds.")]
    public string restoreCue = "restore";
    [Tooltip("Also put them back automatically after this long. 0 = only on the restore cue.")]
    public float autoRestoreSeconds = 0f;

    [Header("What changes (same size, same order)")]
    public Renderer[] renderers;
    public Material[] swapTo;

    private Material[][] _original;
    private bool _swapped;
    private bool _ready;

    void Start()
    {
        if (renderers == null || swapTo == null || renderers.Length == 0)
        {
            Debug.LogWarning("[CueMaterialSwap] nothing to swap — fill in renderers and swapTo");
            return;
        }
        if (renderers.Length != swapTo.Length)
        {
            Debug.LogError("[CueMaterialSwap] renderers (" + renderers.Length + ") and swapTo (" + swapTo.Length + ") must be the same length");
            return;
        }
        _original = new Material[renderers.Length][];
        for (int i = 0; i < renderers.Length; i++)
        {
            if (renderers[i] != null) _original[i] = renderers[i].sharedMaterials;
        }
        _ready = true;
        Debug.Log("[CueMaterialSwap] ready, " + renderers.Length + " objects");
    }

    public void OnRadioCue()
    {
        if (!_ready) return;
        if (applyCue.Length > 0 && radioCue == applyCue) { Apply(); return; }
        if (restoreCue.Length > 0 && radioCue == restoreCue) { Restore(); return; }
        // any other cue: not ours
    }

    public void Apply()
    {
        if (!_ready || _swapped) return;
        for (int i = 0; i < renderers.Length; i++)
        {
            if (renderers[i] == null || swapTo[i] == null) continue;
            int slots = _original[i].Length;
            if (slots < 1) slots = 1;
            Material[] m = new Material[slots];
            for (int s = 0; s < slots; s++) m[s] = swapTo[i];
            renderers[i].sharedMaterials = m;
        }
        _swapped = true;
        Debug.Log("[CueMaterialSwap] applied");
        if (autoRestoreSeconds > 0f) SendCustomEventDelayedSeconds(nameof(Restore), autoRestoreSeconds);
    }

    public void Restore()
    {
        if (!_ready || !_swapped) return;
        for (int i = 0; i < renderers.Length; i++)
        {
            if (renderers[i] == null || _original[i] == null) continue;
            renderers[i].sharedMaterials = _original[i];
        }
        _swapped = false;
        Debug.Log("[CueMaterialSwap] restored");
    }
}
