import pytest

from coworker.connectors.browser_automation import launch_chromium


class Chromium:
    def __init__(self, *failures):
        self.failures = list(failures)
        self.calls = []

    def launch(self, **options):
        self.calls.append(options)
        if self.failures:
            raise self.failures.pop(0)
        return options


class Playwright:
    def __init__(self, chromium):
        self.chromium = chromium


def test_missing_bundled_chromium_falls_back_to_installed_chrome():
    chromium = Chromium(RuntimeError("BrowserType.launch: Executable doesn't exist at /x"))
    assert launch_chromium(Playwright(chromium), headless=False) == {"channel": "chrome", "headless": False}


def test_other_launch_errors_and_missing_chrome_keep_the_original_error():
    with pytest.raises(RuntimeError, match="sandbox"):
        launch_chromium(Playwright(Chromium(RuntimeError("sandbox denied"))))
    missing = RuntimeError("Executable doesn't exist at /x")
    with pytest.raises(RuntimeError) as raised:
        launch_chromium(Playwright(Chromium(missing, RuntimeError("chrome not found"))))
    assert raised.value is missing
