from vm.control_plane import control_host, order_url
from vm.server_health import VMServerHealth

SERIAL = "AB12cd34EF56"


def test_defaults_to_production():
    assert control_host({}) == "flagshipserver.com"
    assert order_url(SERIAL, "status", {}) == f"https://flagshipserver.com/api/order/{SERIAL}/status"


def test_follows_flagship_control_host():
    env = {"FLAGSHIP_CONTROL_HOST": "gym.flagshipserver.com"}
    assert order_url(SERIAL, "status", env) == f"https://gym.flagshipserver.com/api/order/{SERIAL}/status"
    assert order_url(SERIAL, "health", env) == f"https://gym.flagshipserver.com/api/order/{SERIAL}/health"


def test_ignores_a_value_that_is_not_a_plain_host():
    for bad in ("", "  ", "evil.example/x", "a b", "https://gym.example", "x@y"):
        assert control_host({"FLAGSHIP_CONTROL_HOST": bad}) == "flagshipserver.com", bad


def test_health_url_follows_the_environment(monkeypatch):
    monkeypatch.setenv("FLAGSHIP_CONTROL_HOST", "gym.flagshipserver.com")
    assert VMServerHealth.order_health_url(SERIAL) == f"https://gym.flagshipserver.com/api/order/{SERIAL}/health"
    assert VMServerHealth.order_health_url("no") is None


def test_install_status_poll_uses_the_control_host(monkeypatch):
    import inspect
    from vm import manager
    src = inspect.getsource(manager.VMManager._sync_install_poll)
    assert 'order_url(serial, "status")' in src
    assert "flagshipserver.com" not in src
