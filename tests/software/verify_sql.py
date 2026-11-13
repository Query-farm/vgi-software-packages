"""Deterministic real-engine tests for both production workers and all adapters."""
import importlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
engine = os.environ.get("ENGINE", "haybarn")
module = importlib.import_module(engine)
transport = os.environ.get("TRANSPORT", "stdio")
binary_dir = Path(os.environ.get("SOFTWARE_BIN_DIR", root / "bin")).resolve()
processes = []
checks = []

def literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def location(catalog):
    exe = binary_dir / f"vgi-{catalog}-worker{'.exe' if os.name == 'nt' and binary_dir.name != 'bin' else ''}"
    if transport != "http":
        return ("launch:" if transport == "launch" else "") + str(exe)
    p = subprocess.Popen([str(exe), "--http", "--host", "127.0.0.1", "--port", "0"], stdout=subprocess.PIPE, text=True)
    processes.append(p)
    line = p.stdout.readline().strip()
    assert line.startswith("PORT:"), line
    return "http://127.0.0.1:" + line.split(":")[1]

with tempfile.TemporaryDirectory(prefix="vgi-sql-repositories-") as directory:
    db = module.connect(":memory:", config={"extension_repository_directory": directory} if engine == "duckdb" else {})
    try:
        if engine == "duckdb":
            db.execute("SET allow_extension_repositories = 'allowed'")
            db.execute("CREATE EXTENSION REPOSITORY query_farm WITH PREFIX 'https://duckdb-extensions.query.farm'")
            db.execute("INSTALL vgi FROM query_farm; LOAD vgi FROM query_farm")
        else:
            db.execute("INSTALL vgi FROM community; LOAD vgi")
        if transport == "http":
            db.execute("INSTALL httpfs; LOAD httpfs")
        for catalog in ("packages", "containers"):
            sql = f"ATTACH '{catalog}' (TYPE vgi, LOCATION {literal(location(catalog))})"
            db.execute(sql)
            checks.append(sql)

        def check(sql, expected):
            actual = db.execute(sql).fetchall()
            assert actual == expected, (sql, actual, expected)
            checks.append(sql)

        def fails(sql, message):
            try:
                db.execute(sql).fetchall()
            except Exception as e:
                assert message in str(e), str(e)
            else:
                raise AssertionError(f"Expected {message}: {sql}")
            checks.append(sql)

        check("SELECT count(*) FROM packages.main.sources", [(21,)])
        check("SELECT count(*) FROM containers.main.sources", [(4,)])
        check("SELECT count(*) FROM packages.main.source_status WHERE search_mode='indexed' AND ready AND complete", [(13,)])
        check("SELECT count(*) FROM packages.main.versions('npm_test','demo')", [(600,)])
        check("SELECT count(*) FROM packages.main.search('npm_test','demo',300)", [(300,)])
        check("SELECT count(*) FROM packages.main.search('npm_test','absent',25)", [(0,)])
        check("SELECT size, yanked FROM packages.main.artifacts('pypi_test','demo','1.0')", [(42,True)])
        for kind in ["npm","pypi","crates","maven","nuget","rubygems","go","conda","homebrew","apt","rpm","alpine","nixpkgs","packagist","pub","hex","cran","bioconductor","vcpkg","homebrew_casks","dockerhub","quay","ghcr","gitlab"]:
            catalog = "containers" if kind in ("dockerhub","quay","ghcr","gitlab") else "packages"
            check(f"SELECT count(*) BETWEEN 1 AND 25 FROM {catalog}.main.search('{kind}_test','demo',25)", [(True,)])
        digest = os.environ["VGI_FIXTURE_DIGEST"]
        check("SELECT dependency, requirement FROM packages.main.dependencies('packagist_test','vendor/demo','1.0') WHERE kind='require' ORDER BY dependency", [('php','>=8.1'),('vendor/helper','^2')])
        check("SELECT version, yanked FROM packages.main.versions('pub_test','demo')", [('1.0',True)])
        check("SELECT dependency, kind FROM packages.main.dependencies('hex_test','demo','1.0')", [('helper','optional')])
        check("SELECT dependency, kind FROM packages.main.dependencies('bioconductor_test','demo','1.0') WHERE dependency='R'", [('R','Depends')])
        check("SELECT version, build FROM packages.main.versions('vcpkg_test','demo') ORDER BY version", [('1.0#2','2'),('old','0')])
        check("SELECT dependency FROM packages.main.dependencies('vcpkg_test','demo','1.0#2') WHERE kind='host'", [('vcpkg-cmake',)])
        fails("SELECT * FROM packages.main.dependencies('vcpkg_test','demo','old')", "VERSION_SCOPE")
        check("SELECT artifact_type FROM packages.main.artifacts('homebrew_casks_test','demo-app','1.0')", [('cask',)])
        for provider in ('ghcr','gitlab'):
            check(f"SELECT name FROM containers.main.repository('{provider}_test','example/demo')", [('example/demo',)])
            check(f"SELECT os, architecture FROM containers.main.configuration('{provider}_test','example/demo',{literal(digest)})", [('linux','amd64')])
        check("SELECT digest FROM containers.main.platforms('dockerhub_test','library/demo','latest')", [(digest,)])
        check(f"SELECT position, size FROM containers.main.layers('quay_test','example/demo',{literal(digest)})", [(0,42)])
        check(f"SELECT os, architecture FROM containers.main.configuration('quay_test','example/demo',{literal(digest)})", [('linux','amd64')])
        fails("SELECT * FROM packages.main.search('npm_test','',5)", "ARGUMENT")
        fails("SELECT * FROM packages.main.dependencies('nixpkgs_test','demo','1.0')", "UNSUPPORTED")
        fails("SELECT * FROM containers.main.layers('dockerhub_test','library/demo','latest')", "PLATFORM_REQUIRED")
        fails("SELECT * FROM packages.main.search('npm_private','demo',5)", "AUTH_REQUIRED")
        db.execute("CREATE SECRET fixture_registry (TYPE software_registry, SOURCE_ID 'npm_private', TOKEN 'fixture-read-token')")
        check("SELECT count(*) FROM packages.main.search('npm_private','demo',5)", [(5,)])
        db.execute("DROP SECRET fixture_registry")
        fails("SELECT * FROM packages.main.search('npm_private','demo',5)", "AUTH_REQUIRED")
        version = db.execute("SELECT extension_version FROM duckdb_extensions() WHERE extension_name='vgi'").fetchone()[0]
        print(json.dumps({"engine":engine,"version":module.__version__,"extension":version,"transport":transport,"checks":len(checks),"status":"passed"}))
    finally:
        db.close()
        for p in processes:
            p.terminate()
            p.wait(timeout=10)
