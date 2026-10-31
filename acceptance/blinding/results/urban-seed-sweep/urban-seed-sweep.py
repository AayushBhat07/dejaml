import json, subprocess, sys
from pathlib import Path
adapter, train, test, out = sys.argv[1:5]
res = {}
for seed in range(0, 200):
    o = Path(out) / f"s{seed}.json"
    p = subprocess.run([sys.executable, adapter, "--training", train, "--testing", test, "--output", str(o), "--seed", str(seed)], capture_output=True, text=True)
    if p.returncode != 0:
        res[seed] = None; continue
    d = json.loads(o.read_text())
    res[seed] = d["metrics"]["accuracyPercent"]
print(json.dumps(res))
