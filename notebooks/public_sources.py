"""Anonymous public-source configuration; all retrieval and analysis stay in SQL."""

import atexit
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory


class PublicSources:
    """Use anonymous public registries and an empty disposable cache."""

    def __init__(self):
        """Write supported source configuration without touching user settings."""
        self.directory = TemporaryDirectory(prefix="vgi-software-notebook-")
        self.previous = {k: os.environ.get(k) for k in ("VGI_SOFTWARE_CONFIG", "VGI_SOFTWARE_CACHE")}
        self.closed = False
        folder = Path(self.directory.name)
        settings = {
            "sources": [
                {"id": "npm_public", "kind": "npm", "url": "https://registry.npmjs.org", "auth": {"mode": "anonymous"}},
                {"id": "pypi_public", "kind": "pypi", "url": "https://pypi.org", "auth": {"mode": "anonymous"}},
                {
                    "id": "quay_public",
                    "kind": "quay",
                    "url": "https://quay.io",
                    "registry_url": "https://quay.io",
                    "allowed_origins": ["https://cdn01.quay.io", "https://cdn02.quay.io", "https://cdn03.quay.io"],
                    "auth": {"mode": "anonymous"},
                    "registry_auth": {"mode": "anonymous"},
                },
            ],
            "cache_dir": str(folder / "cache"),
        }
        (folder / "config.json").write_text(json.dumps(settings))
        os.environ["VGI_SOFTWARE_CONFIG"] = str(folder / "config.json")
        os.environ["VGI_SOFTWARE_CACHE"] = str(folder / "cache")
        atexit.register(self.close)

    def close(self):
        """Restore environment settings and remove this run's cache."""
        if self.closed:
            return
        self.closed = True
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.directory.cleanup()
