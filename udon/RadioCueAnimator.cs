// RadioCueAnimator.cs — UdonSharp
//
// Fires Animator triggers for ONE named cue. Add one of these per cue event, list them all
// in StarlightNowPlaying's `Cue Targets`, and each reacts only to its own event.
//
// This exists because VRChat allows one string download every 5 seconds per world, so there
// must only ever be a single StarlightNowPlaying doing the polling. It fans out to every
// receiver, and each receiver decides whether the cue is its own.
//
// Setup
//   1. Empty GameObject, Add Component → Radio Cue Animator.
//   2. `onlyCueNamed` = the event name from cues.json, e.g. "hijack" or "powerdown".
//   3. `animators` = the props that should react; they all need the same trigger name.
//   4. On StarlightNowPlaying: add this object to `Cue Targets`,
//      `Cue Target Event` = OnRadioCue, and leave its own `onlyCueNamed` EMPTY.
//
// `delaySeconds` offsets this receiver from the cue instant, so several receivers can
// stagger off one event. For a delay that should apply to every receiver, use the `offset`
// in cues.json on the server instead.

using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class RadioCueAnimator : UdonSharpBehaviour
{
    [Header("Which cue")]
    [Tooltip("Set by StarlightNowPlaying just before it calls OnRadioCue. Do not edit.")]
    [HideInInspector] public string radioCue = "";
    [Tooltip("React only to this cue name, e.g. hijack. Empty = react to every cue.")]
    public string onlyCueNamed = "";

    [Header("What to drive")]
    public Animator[] animators;
    [Tooltip("Trigger parameter, the same on every animator above.")]
    public string trigger = "RadioCue";
    [Tooltip("Optional bool to set instead of / as well as the trigger. Leave empty to skip.")]
    public string boolParameter = "";
    public bool boolValue = true;

    [Header("Timing")]
    [Tooltip("Seconds after the cue instant before this receiver fires. 0 = on the moment.")]
    public float delaySeconds = 0f;

    public void OnRadioCue()
    {
        if (onlyCueNamed.Length > 0 && radioCue != onlyCueNamed) return;
        if (delaySeconds > 0f)
        {
            SendCustomEventDelayedSeconds(nameof(Fire), delaySeconds);
            return;
        }
        Fire();
    }

    public void Fire()
    {
        int n = 0;
        if (animators != null)
        {
            for (int i = 0; i < animators.Length; i++)
            {
                if (animators[i] == null) continue;
                if (trigger.Length > 0) animators[i].SetTrigger(trigger);
                if (boolParameter.Length > 0) animators[i].SetBool(boolParameter, boolValue);
                n++;
            }
        }
        Debug.Log("[RadioCueAnimator] '" + onlyCueNamed + "' fired -> " + n + " animators");
    }
}
