"""校验 .github/workflows/release.yml 的 YAML 语法与关键结构（临时脚本，不进仓库）。"""

import sys

import yaml

path = ".github/workflows/release.yml"
with open(path, encoding="utf-8") as fh:
    doc = yaml.safe_load(fh)

print("YAML 解析 OK")
# YAML 1.1 里裸 on 会被解析成布尔 True，两种都接受
trigger = doc.get(True, doc.get("on"))
print("触发条件:", trigger)
print("顶层键:", list(doc.keys()))
jobs = doc["jobs"]
print("jobs:", list(jobs.keys()))

fail = []
for name, job in jobs.items():
    steps = job.get("steps", [])
    runs_on = job.get("runs-on")
    print(f"  {name}: runs-on={runs_on} steps={len(steps)}")
    for i, step in enumerate(steps, 1):
        if not (step.get("uses") or step.get("run")):
            fail.append(f"{name} 第 {i} 步既没有 uses 也没有 run")
        if step.get("run") and "\t" in str(step["run"]):
            fail.append(f"{name} 第 {i} 步 run 里含 Tab")

if "release" in jobs and jobs["release"].get("needs") != ["windows", "linux"]:
    fail.append("release job 的 needs 不是 [windows, linux]")

publish = jobs.get("release", {}).get("steps", [])
if not any("action-gh-release" in str(s.get("uses", "")) for s in publish):
    fail.append("release job 里没有 action-gh-release 步骤")

print("结构问题:", fail if fail else "无")
sys.exit(1 if fail else 0)
