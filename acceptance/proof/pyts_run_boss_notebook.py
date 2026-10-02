"""Tiny DejaML wrapper: execute the code cells of the OFFICIAL pyts-repro
notebook 0.10.0/BOSS.ipynb unchanged, in order, in one namespace.

The only intervention: after the cell that defines `dataset_params`, the dict
is filtered to the datasets named on the command line (default: GunPoint),
because the other UCR datasets must be downloaded from
timeseriesclassification.com, which is unreachable in the offline lab.
Per-dataset computation is independent, so the GunPoint result is unaffected.
"""
import json, resource, sys, time

nb_path = sys.argv[1]
keep = sys.argv[2].split(",") if len(sys.argv) > 2 else ["GunPoint"]
nb = json.load(open(nb_path))
ns = {"__name__": "__main__"}
t0 = time.time()
for i, cell in enumerate(nb["cells"]):
    if cell["cell_type"] != "code":
        continue
    src = "".join(cell["source"])
    exec(compile(src, f"{nb_path}#cell{i}", "exec"), ns)
    if "dataset_params" in ns and not ns.get("_dejaml_filtered"):
        ns["dataset_params"] = {k: v for k, v in ns["dataset_params"].items() if k in keep}
        ns["_dejaml_filtered"] = True
        print(f"[dejaml] restricted dataset_params to {list(ns['dataset_params'])}", flush=True)
print(f"[dejaml] wall_seconds={time.time()-t0:.2f}")
print(f"[dejaml] peak_rss_kb={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}")
