using Xunit;
using Flagship.Burner;

namespace Flagship.Burner.Tests;

/// <summary>
/// Wizard state-machine smoke tests, expressed against a stand-in
/// `WizardStateView` that mirrors the relevant slice of Wizard.cs
/// without dragging WPF into the test project.
///
/// The real Wizard view-model exposes these same derived properties.
/// The properties under test here are the readiness rules
/// (`CanBake`, `ReadinessSummary`) which the Mac/Linux versions also
/// pin in their unit tests.
/// </summary>
public class WizardStateMachineTests
{
    // ---- Simple mode (the default): no user ISO, base comes from the server. ----

    [Fact]
    public void NewState_Simple_HasNothingReady()
    {
        var s = new WizardStateView();
        Assert.Equal(BurnerMode.Simple, s.Mode);
        Assert.False(s.CanBake);
        Assert.False(s.HasRecipe);
        Assert.False(s.HasDisk);
        // Simple mode never asks for an ISO.
        Assert.Equal("Need: recipe, USB drive.", s.ReadinessSummary);
    }

    [Fact]
    public void Simple_AfterRecipeOnly_NeedsDisk()
    {
        var s = new WizardStateView { RecipePath = @"C:\tmp\recipe.json" };
        Assert.False(s.CanBake);
        Assert.Equal("Need: USB drive.", s.ReadinessSummary);
    }

    [Fact]
    public void Simple_RecipeAndDisk_CanBake_NoIsoNeeded()
    {
        var s = new WizardStateView
        {
            RecipePath = @"C:\tmp\recipe.json",
            SelectedDevice = @"\\.\PhysicalDrive2",
        };
        Assert.True(s.CanBake);
        Assert.Equal(@"Writes to \\.\PhysicalDrive2 · erases what's there", s.ReadinessSummary);
    }

    // ---- Advanced mode: the user supplies their own ISO. ----

    [Fact]
    public void Advanced_NewState_HasNothingReady()
    {
        var s = new WizardStateView { Mode = BurnerMode.Advanced };
        Assert.False(s.CanBake);
        Assert.False(s.HasRecipe);
        Assert.False(s.HasIso);
        Assert.False(s.HasDisk);
        Assert.Equal("Need: recipe, ISO, USB drive.", s.ReadinessSummary);
    }

    [Fact]
    public void Advanced_AfterRecipeOnly_NeedsIsoAndDisk()
    {
        var s = new WizardStateView { Mode = BurnerMode.Advanced, RecipePath = @"C:\tmp\recipe.json" };
        Assert.False(s.CanBake);
        Assert.Equal("Need: ISO, USB drive.", s.ReadinessSummary);
    }

    [Fact]
    public void Advanced_AfterRecipeAndIso_NeedsDisk()
    {
        var s = new WizardStateView
        {
            Mode = BurnerMode.Advanced,
            RecipePath = @"C:\tmp\recipe.json",
            IsoPath = @"C:\tmp\ubuntu.iso",
        };
        Assert.False(s.CanBake);
        Assert.Equal("Need: USB drive.", s.ReadinessSummary);
    }

    [Fact]
    public void Advanced_AllThreeSet_CanBake()
    {
        var s = new WizardStateView
        {
            Mode = BurnerMode.Advanced,
            RecipePath = @"C:\tmp\recipe.json",
            IsoPath = @"C:\tmp\ubuntu.iso",
            SelectedDevice = @"\\.\PhysicalDrive2",
        };
        Assert.True(s.CanBake);
        Assert.Equal(@"Writes to \\.\PhysicalDrive2 · erases what's there", s.ReadinessSummary);
    }

    [Fact]
    public void Running_BlocksBakeAndChangesSummary()
    {
        var s = new WizardStateView
        {
            RecipePath = @"C:\tmp\recipe.json",
            SelectedDevice = @"\\.\PhysicalDrive2",
            IsRunning = true,
        };
        Assert.False(s.CanBake);
        Assert.Equal("Working...", s.ReadinessSummary);
    }

    [Fact]
    public void Finished_DisablesBake()
    {
        var s = new WizardStateView
        {
            RecipePath = @"C:\tmp\recipe.json",
            SelectedDevice = @"\\.\PhysicalDrive2",
            IsFinished = true,
        };
        Assert.False(s.CanBake);
    }
}

/// <summary>
/// Plain mirror of the Wizard view-model's derived state — same rules,
/// no WPF dependencies. If the rules in Wizard.cs change, update both.
///
/// Simple is the default mode (base comes from the server, no user ISO);
/// Advanced requires a user-supplied ISO.
/// </summary>
internal sealed class WizardStateView
{
    public string? RecipePath { get; set; }
    public string? IsoPath { get; set; }
    public string? SelectedDevice { get; set; }
    public bool IsRunning { get; set; }
    public bool IsFinished { get; set; }
    public BurnerMode Mode { get; set; } = BurnerMode.Simple;

    private bool RequiresIso => Mode.RequiresUserISO();

    public bool HasRecipe => !string.IsNullOrEmpty(RecipePath);
    public bool HasIso => !string.IsNullOrEmpty(IsoPath);
    public bool HasDisk => !string.IsNullOrEmpty(SelectedDevice);
    public bool CanBake =>
        HasRecipe && (!RequiresIso || HasIso) && HasDisk && !IsRunning && !IsFinished;

    public string ReadinessSummary
    {
        get
        {
            var missing = new System.Collections.Generic.List<string>();
            if (!HasRecipe) missing.Add("recipe");
            if (RequiresIso && !HasIso) missing.Add("ISO");
            if (!HasDisk) missing.Add("USB drive");
            if (missing.Count == 0)
            {
                if (IsRunning) return "Working...";
                return $"Writes to {SelectedDevice} · erases what's there";
            }
            return $"Need: {string.Join(", ", missing)}.";
        }
    }
}

/// <summary>Mode-helper pins: Simple fetches the base from the server (no user
/// ISO); Advanced remasters a user-supplied ISO.</summary>
public class BurnerModeRules
{
    [Fact]
    public void SimpleMode_DoesNotRequireUserIso()
        => Assert.False(BurnerMode.Simple.RequiresUserISO());

    [Fact]
    public void AdvancedMode_RequiresUserIso()
        => Assert.True(BurnerMode.Advanced.RequiresUserISO());

    [Fact]
    public void BothModes_RequireRecipe()
    {
        Assert.True(BurnerMode.Simple.RequiresRecipe());
        Assert.True(BurnerMode.Advanced.RequiresRecipe());
    }

    [Fact]
    public void MenuLabels_AreSimpleAndAdvanced()
    {
        Assert.Equal("Simple", BurnerMode.Simple.MenuLabel());
        Assert.Equal("Advanced", BurnerMode.Advanced.MenuLabel());
    }

    [Fact]
    public void BakeCtaLabels_DifferByMode()
    {
        Assert.Equal("Flash to USB", BurnerMode.Simple.BakeCtaLabel());
        Assert.Equal("Assemble and flash", BurnerMode.Advanced.BakeCtaLabel());
    }
}
