'use strict';
// Held-out fixtures written after the rate table was chosen. Used only to check
// the heuristic, never to tune it.

const englishChat = `Hey, quick question before I head out. I tried the steps you gave me yesterday and the first two worked fine, but the third one keeps failing with a permissions error. I'm not sure if it's because I'm on the shared laptop or if I missed something obvious. Could you take another look when you get a chance? No rush, tomorrow morning is totally fine.

Sure. That error usually means the folder is owned by a different account. Open a terminal, check who owns the folder, and if it isn't you, either ask the admin to change it or copy the project somewhere inside your own home directory and try again from there. If it still fails after that, send me the full error message and the exact command you ran, and I'll dig in.`;

const englishTechnical = `The cache layer sits between the API gateway and the database. Reads first check an in-memory store with a 300-second TTL; on a miss, the request falls through to the primary replica and the result is written back asynchronously. Writes invalidate keys by prefix, which keeps the logic simple but occasionally evicts more entries than necessary.

During load testing at 4,000 requests per second, the hit rate stabilized at roughly 87 percent and median latency dropped from 42 ms to 9 ms. The long tail was dominated by cold keys after deployments, so we now warm the 500 most frequently requested keys during the rollout. Memory usage stayed under 1.2 GB per node, well within the 4 GB budget.`;

const chineseChat = `你好，我昨天按照你说的步骤试了一下，前两步都没问题，但是第三步一直报权限错误。我不确定是因为我用的是公用电脑，还是我漏掉了什么明显的地方。你有空的时候能再帮我看看吗？不着急，明天上午也可以。

好的。这个错误通常说明文件夹属于另一个账户。打开终端，看一下文件夹的所有者，如果不是你，可以请管理员修改，或者把项目复制到你自己的主目录下面再试一次。如果还是失败，把完整的错误信息和你运行的命令发给我，我再仔细查一下。`;

const mixedNotes = `会议纪要：本周 sprint review 主要讨论了三个问题。第一，登录页面的 A/B test 结果显示新版本转化率提升了 4.6%，但是样本量只有 1,200 人，统计显著性还不够。第二，payment service 在高峰期出现了 3 次 timeout，SRE 团队建议把 connection pool 从 50 调到 120。第三，移动端的 crash rate 在 iOS 17 上明显偏高，需要 mobile team 优先排查。Action items: Alice owns the A/B follow-up, Bob updates the pool config, and the mobile team reports back by Thursday.`;

const pythonCode = `from dataclasses import dataclass, field
from typing import Iterable


@dataclass
class Budget:
    limit: int
    spent: int = 0
    history: list[int] = field(default_factory=list)

    def charge(self, amount: int) -> bool:
        if amount <= 0:
            raise ValueError("amount must be positive")
        if self.spent + amount > self.limit:
            return False
        self.spent += amount
        self.history.append(amount)
        return True

    @property
    def remaining(self) -> int:
        return self.limit - self.spent


def apply_all(budget: Budget, charges: Iterable[int]) -> list[bool]:
    return [budget.charge(c) for c in charges]


if __name__ == "__main__":
    b = Budget(limit=1000)
    print(apply_all(b, [200, 300, 600, 100]), b.remaining)
`;

const yamlConfig = `service:
  name: billing-api
  replicas: 3
  image: registry.example.com/billing-api:2.14.1
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits: { cpu: "1", memory: 1Gi }
  env:
    - name: DB_POOL_SIZE
      value: "120"
    - name: REQUEST_TIMEOUT_MS
      value: "4500"
    - name: FEATURE_FLAGS
      value: "new-invoice-ui,async-refunds"
probes:
  readiness: { path: /healthz, periodSeconds: 10, failureThreshold: 3 }
  liveness: { path: /livez, periodSeconds: 20, failureThreshold: 5 }`;

function makeCsv() {
  const lines = ['date,region,orders,revenue_usd,refunds,avg_basket'];
  for (let i = 0; i < 30; i++) {
    lines.push(`2026-09-${String(i + 1).padStart(2, '0')},${['NA', 'EMEA', 'APAC'][i % 3]},${1200 + ((i * 377) % 900)},${(48000 + ((i * 7919) % 22000)).toFixed(2)},${(i * 13) % 40},${(31 + ((i * 17) % 23) / 10).toFixed(2)}`);
  }
  return lines.join('\n');
}

function makeToolResult() {
  const items = [];
  for (let i = 0; i < 12; i++) {
    items.push({
      path: `src/modules/feature_${i}/index.ts`,
      matches: [{ line: 10 + i * 3, text: `export function handler${i}(req: Request): Promise<Response> {` }],
      sizeBytes: 2048 + i * 311,
      lastModified: `2026-10-${String(10 + (i % 9)).padStart(2, '0')}T09:${String(i * 4).padStart(2, '0')}:00Z`,
    });
  }
  return JSON.stringify({ tool: 'search_files', query: 'export function handler', results: items });
}

module.exports = {
  englishChat,
  englishTechnical,
  chineseChat,
  mixedNotes,
  pythonCode,
  yamlConfig,
  csv: makeCsv(),
  toolResult: makeToolResult(),
};
