"""Public-source isolation and chart presentation; retrieval and analysis stay in SQL."""

import atexit
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import matplotlib.pyplot as plt
import seaborn as sns


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


def theme():
    """Set readable defaults, keeping text independent of math parsing."""
    sns.set_theme(style="whitegrid", context="notebook", font_scale=1.05)
    plt.rcParams.update(
        {
            "figure.dpi": 130,
            "savefig.dpi": 150,
            "text.parse_math": False,
            "axes.spines.top": False,
            "axes.spines.right": False,
        }
    )


def finish(fig, name, title, subtitle, source, left=0.12):
    """Save and display a figure with units, source and UTC retrieval context."""
    fig.suptitle(title, x=0.08, y=0.98, ha="left", fontsize=17, fontweight="bold", color="#243e32")
    fig.text(0.08, 0.92, subtitle, ha="left", fontsize=10.5, color="#526b5b")
    fig.text(
        0.08,
        0.025,
        source + "\nvgi-software-packages v0.2.0 through Haybarn / VGI · metadata only; no payload downloads",
        fontsize=9,
        color="#526b5b",
    )
    fig.subplots_adjust(left=left, right=0.96, bottom=0.22, top=0.79)
    folder = Path("validation/charts")
    folder.mkdir(parents=True, exist_ok=True)
    fig.savefig(folder / f"{name}.png", bbox_inches="tight")
    plt.show()
