import container_env


def test_detects_crostini_when_any_marker_exists():
    assert container_env.is_chromeos_container(
        exists=lambda p: p == "/opt/google/cros-containers"
    )
    assert container_env.is_chromeos_container(
        exists=lambda p: p == "/dev/.cros_milestone"
    )


def test_not_crostini_when_no_marker_exists():
    assert not container_env.is_chromeos_container(exists=lambda _p: False)


def test_generic_hint_off_chromeos():
    hint = container_env.no_disks_hint(chromeos=False)
    assert hint == container_env.NO_DISKS_GENERIC


def test_crostini_hint_explains_usb_sharing_and_host_here():
    hint = container_env.no_disks_hint(chromeos=True)
    assert "Manage USB devices" in hint
    assert "Host on this PC" in hint
