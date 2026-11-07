// StarlightDonorBoard.cs — UdonSharp
//
// High-score style board of Ko-fi supporters, in the Seven Segment font.
//
// It makes no web requests of its own. The station puts `donor1=50.00|Name` lines in /now.txt and
// StarlightNowPlaying hands them over here, so the board costs no extra string downloads and
// updates as fast as the radio polls.
//
// Setup
//   Menu: Starlight > Create Donor Board builds this in the open scene and links it to
//   StarlightNowPlaying. Move it into place and save the scene.

using UdonSharp;
using UnityEngine;
using TMPro;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]   // every client reads the same text from the station
public class StarlightDonorBoard : UdonSharpBehaviour
{
    [Header("One entry per row, best first")]
    public TextMeshProUGUI[] nameTexts;
    public TextMeshProUGUI[] amountTexts;

    [Header("Display")]
    [Tooltip("Seven segment letters read better in capitals.")]
    public bool upperCaseNames = true;
    public int maxNameLength = 16;
    [Tooltip("Shown on rows with nobody on them yet.")]
    public string emptyName = "---";

    [Header("Testing")]
    [TextArea(3, 6)]
    [Tooltip("Paste donor1=50.00|Name lines to preview in Play mode. Leave EMPTY for upload: anything here shows until the station sends real lines.")]
    public string previewDonors = "";

    void Start()
    {
        ShowDonors(previewDonors);
    }

    // Lines look like `donor1=50.00|Name`. The server sends them best first.
    public void ShowDonors(string donors)
    {
        int row = 0;
        string[] lines = donors.Split('\n');
        for (int i = 0; i < lines.Length && row < nameTexts.Length; i++)
        {
            string line = lines[i].Trim();
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string value = line.Substring(eq + 1);
            int bar = value.IndexOf('|');
            if (bar <= 0) continue;

            string amount = value.Substring(0, bar);
            string donor = value.Substring(bar + 1);
            float parsed;
            if (!float.TryParse(amount, out parsed)) continue;   // the amount text allows rich text, so only ever numbers

            if (upperCaseNames) donor = donor.ToUpper();
            if (donor.Length > maxNameLength) donor = donor.Substring(0, maxNameLength);

            SetRow(row, donor, Digits(amount));
            row++;
        }
        for (; row < nameTexts.Length; row++) SetRow(row, emptyName, "");
    }

    // The font's 1 is much narrower than its 8, so digits need a fixed width to line up over the
    // unlit 8s behind them. 0.5em is the width of the font's 8.
    private string Digits(string amount)
    {
        int dot = amount.IndexOf('.');
        if (dot < 0) return "<mspace=0.5em>" + amount + "</mspace>";
        return "<mspace=0.5em>" + amount.Substring(0, dot) + "</mspace>"
             + "<mspace=0.18em>.</mspace>"
             + "<mspace=0.5em>" + amount.Substring(dot + 1) + "</mspace>";
    }

    private void SetRow(int row, string donor, string amount)
    {
        if (nameTexts[row] != null) nameTexts[row].text = donor;
        if (row < amountTexts.Length && amountTexts[row] != null) amountTexts[row].text = amount;
    }
}
