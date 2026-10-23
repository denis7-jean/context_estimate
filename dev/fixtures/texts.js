'use strict';
// Original, synthetic fixture texts used to calibrate and test the visible-text
// heuristic. Not part of the upload bundle.

const english = `Our team spent the last quarter rebuilding the deployment pipeline. The old system relied on a single build server that frequently ran out of disk space, which meant that releases were often delayed by hours while someone cleaned up stale artifacts. We replaced it with ephemeral runners that start from a known image, run the build, upload the result, and shut down.

The migration was not entirely smooth. Several older services assumed that build outputs would remain on disk between runs, and those assumptions only surfaced when the first nightly job failed. We added an explicit cache step, documented which directories are safe to persist, and wrote a short checklist for teams moving their services over.

Looking ahead, the next priority is visibility. Engineers should be able to see why a build is slow without opening five different dashboards. We plan to publish a single summary page per build that lists each stage, how long it took, and whether it used the cache. If that page proves useful, we will add trend lines so regressions are obvious within a day rather than a week.

A few open questions remain. Should failed builds keep their runners alive for debugging, and if so, for how long? Who owns the base image, and how often should it be refreshed? We would like feedback from every team before the end of the month, ideally in the shared planning document rather than in private messages, so that decisions are recorded in one place.`;

const chinese = `上个季度，我们的团队重新设计了整个部署流程。旧系统依赖一台构建服务器，磁盘空间经常不足，导致发布常常延迟好几个小时，必须有人手动清理过期的构建产物。现在我们改用临时运行器：每次从固定镜像启动，完成构建、上传结果，然后自动关闭。

迁移过程并不完全顺利。一些较老的服务默认构建输出会在两次运行之间保留在磁盘上，这个假设直到第一次夜间任务失败时才暴露出来。我们增加了明确的缓存步骤，记录了哪些目录可以安全保留，并为迁移服务的团队编写了一份简短的检查清单。

接下来的重点是可观测性。工程师应该能够直接看出构建为什么变慢，而不必打开五个不同的仪表盘。我们计划为每次构建生成一个汇总页面，列出每个阶段的耗时以及是否命中缓存。如果这个页面确实有用，我们还会加入趋势图，让性能退化在一天之内就能被发现，而不是拖到一周以后。

还有几个问题尚未解决。构建失败后是否应该保留运行器以便调试？如果保留，应该保留多久？基础镜像由谁负责维护，多久更新一次？我们希望在月底之前收到每个团队的反馈，最好写在共享的规划文档里，而不是通过私信，这样所有决定都能记录在同一个地方。`;

const mixed = `我们在 Kubernetes 集群里部署了新的 ingress controller，但是 readiness probe 一直失败。日志显示 upstream 连接超时（timeout after 30s），初步怀疑是 NetworkPolicy 配置错误。

排查步骤如下：先用 kubectl describe pod 查看事件，然后检查 Service 的 selector 是否和 Deployment 的 labels 一致。最后发现问题出在 namespace 的默认 deny 规则上，需要额外添加一条 allow 规则，允许来自 ingress-nginx 命名空间的流量。

修复之后，P95 延迟从 850ms 降到了 120ms，错误率也从 2.3% 降到 0.1% 以下。下一步我们会在 CI 里加入 policy 检查，避免类似问题再次发生。Please review the attached manifest before Friday and leave comments in the PR.`;

const code = `import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadConfig(dir, { strict = false } = {}) {
  const file = path.join(dir, 'service.config.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && !strict) return { retries: 3, timeoutMs: 5000 };
    throw new Error(\`Unable to read \${file}: \${err.message}\`);
  }
  const parsed = JSON.parse(raw);
  for (const key of ['retries', 'timeoutMs']) {
    if (!Number.isInteger(parsed[key]) || parsed[key] < 0) {
      throw new TypeError(\`\${key} must be a non-negative integer\`);
    }
  }
  return parsed;
}

def summarize_runs(runs, window=7):
    """Return mean duration and failure rate over the last \`window\` runs."""
    recent = sorted(runs, key=lambda r: r["started_at"])[-window:]
    if not recent:
        return {"mean_s": None, "failure_rate": None}
    durations = [r["finished_at"] - r["started_at"] for r in recent]
    failures = sum(1 for r in recent if r["status"] != "success")
    return {
        "mean_s": round(sum(durations) / len(durations), 2),
        "failure_rate": failures / len(recent),
    }

class RetryPolicy:
    def __init__(self, attempts=3, backoff=1.5):
        self.attempts = attempts
        self.backoff = backoff

    def delays(self):
        delay = 0.5
        for _ in range(self.attempts):
            yield delay
            delay *= self.backoff
`;

function makeJson() {
  const rows = [];
  const regions = ['us-east-1', 'eu-west-2', 'ap-southeast-1'];
  for (let i = 0; i < 24; i++) {
    rows.push({
      id: `job-${1000 + i}`,
      region: regions[i % 3],
      status: i % 5 === 0 ? 'failed' : 'succeeded',
      durationMs: 1200 + ((i * 7919) % 5000),
      cacheHit: i % 2 === 0,
      tags: ['nightly', i % 3 === 0 ? 'canary' : 'stable'],
    });
  }
  return JSON.stringify({ pipeline: 'deploy-main', runs: rows }, null, 2);
}

function makeToolLog() {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const ts = `2026-10-21T14:${String(10 + Math.floor(i / 2)).padStart(2, '0')}:${String((i * 13) % 60).padStart(2, '0')}.${String((i * 37) % 1000).padStart(3, '0')}Z`;
    const level = i % 9 === 0 ? 'WARN' : 'INFO';
    lines.push(`${ts} ${level} worker-${i % 4} GET /api/v2/builds/${48210 + i}/artifacts status=200 bytes=${(i * 7349) % 90000} dur=${(i * 31) % 400}ms trace=${(0x9f3a1c00 + i * 4099).toString(16)}`);
  }
  return lines.join('\n');
}

function makeIdentifiers() {
  const out = [];
  let x = 0x12345678;
  for (let i = 0; i < 30; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const y = (Math.imul(x, 2654435761) >>> 0).toString(16).padStart(8, '0');
    out.push(`sha256:${x.toString(16).padStart(8, '0')}${y}${x.toString(36)} https://example.com/r/${y}?v=${i}`);
  }
  return out.join('\n');
}

const markdownTable = `| Stage | Median (s) | P95 (s) | Cache hit |
| --- | ---: | ---: | :---: |
| checkout | 4.1 | 9.8 | n/a |
| install | 38.2 | 71.5 | 82% |
| compile | 112.7 | 190.3 | 64% |
| test | 241.0 | 402.9 | n/a |
| package | 17.4 | 30.2 | 91% |
| upload | 8.9 | 22.6 | n/a |`;

module.exports = {
  english,
  chinese,
  mixed,
  code,
  json: makeJson(),
  toolLog: makeToolLog(),
  identifiers: makeIdentifiers(),
  markdownTable,
};
