// CueToggleObjects.cs — UdonSharp
//
// Four independent lists, two cues. Each cue switches its own objects on and off, so you are
// not limited to one set simply inverting the other:
//
//   cue "hijack"  ->  showOnApply   switched ON      hideOnApply   switched OFF
//   cue "restore" ->  showOnRestore switched ON      hideOnRestore switched OFF
//
// An object can appear in more than one list. Put the normal prop in hideOnApply and
// showOnRestore to make it come back; leave something only in showOnRestore and it appears
// for the first time after the event (debris, a cracked sign, a changed poster).
//
// Setup
//   1. Empty GameObject → Add Component → Cue Toggle Objects.
//   2. Fill whichever of the four lists you need.
//   3. `applyCue` = hijack, `restoreCue` = restore   (names from cues.json)
//   4. On StarlightNowPlaying: add this object to `Cue Targets`,
//      `Cue Target Event` = OnRadioCue, and leave the poller's own `onlyCueNamed` empty.
//
// `runRestoreAtStart` applies the restore lists when the world loads, which is right when
// "restored" is your normal state. Turn it OFF if something should only ever appear after a
// real hijack, and set the objects by hand in the editor instead.

using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class CueToggleObjects : UdonSharpBehaviour
{
    [Header("Which cues")]
    [Tooltip("Set by StarlightNowPlaying just before it calls OnRadioCue. Do not edit.")]
    [HideInInspector] public string radioCue = "";
    public string applyCue = "hijack";
    [Tooltip("Leave empty if you only use autoRestoreSeconds.")]
    public string restoreCue = "restore";
    [Tooltip("Run the restore lists automatically this long after the apply cue. 0 = only on the restore cue.")]
    public float autoRestoreSeconds = 0f;

    [Header("On the apply cue (hijack)")]
    public GameObject[] showOnApply;
    public GameObject[] hideOnApply;

    [Header("On the restore cue")]
    public GameObject[] showOnRestore;
    public GameObject[] hideOnRestore;

    [Header("Startup")]
    [Tooltip("Apply the restore lists at load, so the world starts in its normal state.")]
    public bool runRestoreAtStart = true;

    void Start()
    {
        if (runRestoreAtStart) Restore();
        Debug.Log("[CueToggleObjects] ready — apply:" + Count(showOnApply) + "/" + Count(hideOnApply)
            + " restore:" + Count(showOnRestore) + "/" + Count(hideOnRestore));
    }

    public void OnRadioCue()
    {
        if (applyCue.Length > 0 && radioCue == applyCue) { Apply(); return; }
        if (restoreCue.Length > 0 && radioCue == restoreCue) { Restore(); return; }
        // any other cue: not ours
    }

    public void Apply()
    {
        SetAll(showOnApply, true);
        SetAll(hideOnApply, false);
        Debug.Log("[CueToggleObjects] apply");
        if (autoRestoreSeconds > 0f) SendCustomEventDelayedSeconds(nameof(Restore), autoRestoreSeconds);
    }

    public void Restore()
    {
        SetAll(showOnRestore, true);
        SetAll(hideOnRestore, false);
        Debug.Log("[CueToggleObjects] restore");
    }

    private void SetAll(GameObject[] list, bool on)
    {
        if (list == null) return;
        for (int i = 0; i < list.Length; i++)
        {
            if (list[i] != null) list[i].SetActive(on);
        }
    }

    private int Count(GameObject[] a)
    {
        return a == null ? 0 : a.Length;
    }
}
