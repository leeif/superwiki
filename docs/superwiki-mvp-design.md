# SuperWiki MVP 技术设计

一个 GitHub 仓库对应一个项目。团队知识以该仓库默认分支的 `wiki/` 为准，Issue 承载 Bounty，PR 承载 Proposal。每个成员在自己的项目目录里有一份本地记忆和一份持续刷新的 Wiki 副本。团队 Agent 使用成员自己的 harness，Curator 由维护者电脑上的 Codex CLI 执行。

**成员 Agent 发 Bounty → GitHub 保存待办 → Curator 轮询并派给成员 → 成员 Agent 在自己的 harness 收到任务 → 回复或提 PR → 合并后，各成员的 Wiki 同步到新版。**

本文中的 `superwiki` 命令、配置和发布包是 MVP 的实现约定。

## 1. 项目目录与 Wiki 同步

```text
<project>/
  wiki/                            # Git 版本管理，合并后的内容是团队知识
    index.md
    always-on.md
    domains/
    members/
  .github/
    ISSUE_TEMPLATE/bounty.yml
    pull_request_template.md
  superwiki.toml                   # 共享设置，默认分支和 Curator 的 GitHub 身份
  .gitignore                       # 忽略 .superwiki/
  .superwiki/                      # 每个本地检出的运行数据
    config.toml                    # 本机账号、harness 和运行配置
    wiki/<commit-sha>/             # 默认分支 wiki/ 的本地只读快照
    memory/
      index.md                     # 项目级本地记忆索引
      notes/                       # 本项目可复用的本地笔记
      transcripts/<profile>/       # 按 harness 或 Agent profile 记录会话
    state/                         # Wiki SHA、收件箱、Dreaming 和 Curator 的处理进度
```

**本地记忆按项目保存。** 同一个检出目录里的 Agent 可以复用 `.superwiki/memory/notes/`。原始会话按 profile 归档，Dreaming 读取当前 profile 的会话和该项目的现有笔记。不同成员机器各有本地记忆。GitHub 写入命令只提交显式选定的团队文档。

**Wiki 在项目目录内持续同步。** `superwiki member run` 启动一个随项目使用的本地进程，启动即同步，之后每 15 秒尝试一次。CLI 从 GitHub 获取默认分支的已合并版本，只在 SHA 改变时更新 `.superwiki/wiki/`。先把完整快照写入 `.superwiki/wiki/<commit-sha>/`，再原子更新 `.superwiki/state/wiki-current.json`。一次查询固定使用一个 SHA，文件删除也随新版快照生效。同步与当前编辑的分支相互独立。发布 Proposal 时，CLI 从默认分支创建临时工作树，把准备好的改动写进受 Git 管理的 `wiki/`。 [Git fetch 文档](https://git-scm.com/docs/git-fetch)

**读取前再同步一次。** `superwiki context` 开工时主动刷新，再读取通用规则、相关 Wiki 和本地笔记。它返回 Wiki 的 SHA、最近同步时间和来源路径。15 秒是在线且进程运行时的轮询间隔。断网或进程停机期间，CLI 可读取最近一次成功的快照，并明确标记版本可能过期。恢复后先追上默认分支。

已有代码检出可以通过 `superwiki project attach --remote <Wiki 仓库 URL>` 绑定已初始化的 Wiki。命令从当前目录找到代码项目根目录，在本地 `.superwiki/config.toml` 保存绑定，并在 `.superwiki/wiki-git/` 管理 Wiki 的 Git 数据。源码仍走自己的 `origin`，知识协作操作走绑定的 Wiki 仓库。Hook、Skill 和本地记忆都使用代码项目的根目录。

## 2. Transcript 和本地 Dreaming

### 记录每轮对话

Codex 安装两个本地 hook。`UserPromptSubmit` 记录用户消息，`Stop` 记录 Agent 的最终回复。hook 把 `cwd`、会话 ID、轮次 ID 和消息交给 CLI，按会话写到 `.superwiki/memory/transcripts/<profile>/<session-id>.jsonl`。CLI 按「会话、轮次、角色」去重，保存时间和必要的本地证据引用。原生 transcript 路径可以用于回查。其他 harness 通过自己的事件或导出文件接入，只有当前上下文的 harness 也能用 Skill 提交一份标记为任务摘要的记录。 [Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)

### 在任务收尾时触发 Dreaming

**默认触发点是团队 Agent 完成一个明确任务，或成员说“记一下这次经验”。** Skill 开工时调用 `superwiki memory start` 创建本地任务 ID。Codex 适配器把会话和当前轮次 ID 通过 hook 上下文提供给 Skill，任务 ID 由此绑定到起始轮次。同一任务跨多轮时继续沿用该 ID。支持导出的 harness 可以在收尾时关联导入记录，通用模式可以用任务摘要。

1. **准备范围。** 收尾时，Skill 调用 `superwiki memory prepare --task <id> --summary-file summary.md`。CLI 取起始轮次到最近已完整记录的一轮，再附上当前回合的工作摘要和证据。这样即使当前回合的 `Stop` 尚未发生，最后一次验证也能纳入整理。用户在中途要求记忆时，可以按当前进度整理已有成果。
2. **提炼经验。** 当前 harness 的 Agent 阅读准备好的输入和同主题笔记，整理可复用的结论、适用条件和依据。
3. **提交结果。** 有结论时，Skill 用 `superwiki memory save --task <id> --file notes.json` 更新项目笔记。没有新增经验时用 `superwiki memory save --task <id> --skip` 记录处理结果。CLI 以准备阶段的输入版本去重，使用本地锁提交笔记和索引更新。写入成功后才推进处理进度，中断后可用原任务 ID 重试。中途主动整理属于检查点，后续收尾时只整理该检查点之后的新内容。
4. **反馈用户。** 例如“已更新本地笔记 `build-cache.md`，建议把验证过的步骤分享给团队”。分享候选此时仍在本地。

Codex hook 每轮记录一次，团队 Skill 每个明确的任务运行一次 Dreaming。用户随时可以主动要求整理。成员自己的 harness 做这项工作，Curator 的本地 Codex 专门处理 GitHub 协作。

## 3. Escalating、Curator 收件和成员收件

### 成员 Agent 怎么发起

| 情况 | Skill 的触发条件 | 发布入口 |
|---|---|---|
| **Bounty** | 查过本地记忆和团队 Wiki，仍有一个团队可以补齐的具体问题。可在任务进行中触发。 | `superwiki bounty create --body-file bounty.md`。先查同类开放 Issue。有相关 Issue 就补充上下文，否则创建带 `sw:bounty` 的 Issue。 |
| **Proposal** | 有可复用、有依据的新增经验，或者发现现有知识需要修正。可在任务收尾、Dreaming 或用户直接要求时触发。 | `superwiki proposal create --path wiki/domains/build.md --file team-note.md --body-file proposal.md`。`--file` 是要纳入 Wiki 的正文，`--body-file` 是 PR 说明。CLI 在同仓库开带 `sw:proposal` 的草稿 PR，附适用条件、可共享证据和关联 Issue。 |

`bounty create`、`proposal create` 和回复命令是显式发布入口。项目启用后，用户可以直接说“帮我发一个 Bounty”或“把这条经验提成 Proposal”。调用前，Skill 把实际要发布的正文和依据写成独立文件。原始会话、本地笔记和账号凭证都在 `.superwiki/` 或系统凭证存储里。

### Curator 怎么收到并下发

1. **收到。** 维护者电脑运行 `superwiki curator run`。启动后立即扫描项目 GitHub 仓库，默认每 15 秒查询带 `sw:bounty` 的开放 Issue 和带 `sw:proposal` 的开放 PR。Issue 评论和 PR 提交有变化时，再取完整上下文。本机休眠或断网时，GitHub 保存待办，恢复后继续扫描。
2. **判断。** Runner 取 Issue、评论、当前 Wiki 和 `wiki/members/`，调用本机 `codex exec` 产出结构化结果。Curator 可以直接整理答案、请提问者补信息，或者建议找适合的成员。模型输出包含建议的处理方式、成员 GitHub 登录名、要完成的子任务和期望回传内容。 [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)
3. **下发。** Runner 校验候选是该仓库可分派的成员，然后通过 GitHub 设置 Issue assignee，并发一条带派单标识的评论，包含 `@成员`、任务范围、提交方式和交付要求。成员匹配优先用 Wiki 中的擅长领域和工作偏好。找不到合适成员时交给配置的维护者。 [GitHub Issue 分派](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users)
4. **交给成员 Agent。** 成员侧 `member run` 按本机配置的 GitHub 登录名拉取分派给自己的开放 Bounty。CLI 验证评论来自项目配置的 Curator 身份，把目标匹配的派单写到本地收件箱。命令行显示 Issue 编号、任务摘要和链接，重复轮询复用同一条派单记录。Codex 安装的 `SessionStart` 和 `UserPromptSubmit` hook 把新派单摘要注入本项目的 Agent 上下文。其他支持同类 hook 的 harness 用对应适配器。通用 Skill 入口是 `superwiki inbox`，也可以直接把 Issue 链接交给 Agent。已在执行的回合继续当前任务，新派单在下一次可注入上下文时出现。成员可以说“接手 #12”，Skill 先用 `superwiki inbox show 12` 读取完整 Issue，再用 `superwiki inbox take 12` 在原 Issue 确认接手。 [Codex Hook 上下文注入](https://learn.chatgpt.com/docs/hooks#common-output-fields)
5. **回传和收尾。** 成员 Agent 查自己的本地记忆和项目资料，用 `superwiki inbox reply 12 --body-file answer.md` 把可共享的答案发到原 Issue，或者直接提一个关联的草稿 PR。Curator 下一轮收到回复后，证据足够就整理成 Proposal，缺信息就继续在原 Issue 追问。维护者合并确认已解决问题的 PR 后，GitHub 根据 `Closes #12` 关闭 Bounty。 [GitHub 关联 PR 与 Issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

**GitHub assignee 决定谁的收件箱能收到派单，评论提供任务内容，harness hook 或 Skill 负责把它带给 Agent。** 成员未打开 harness 时，任务留在收件箱。MVP 的自动接收发生在成员使用项目时，成员确认接手后由自己的 Agent 执行。

Curator 的 PR 审阅意见回到同一个 PR。提交者修改后推送新提交，Curator 再审一轮。Bounty 的输入版本由 Issue 正文和成员的有效回复决定，PR 审阅使用提交 SHA。Curator 自己发出的派单和评论不计入新版本。派单评论使用可查询的稳定标识，重跑时优先补齐已有派单。每个项目单次只跑一个 Curator，超时或失败留待下一轮。Runner 负责 GitHub 写入和状态更新，Codex 在受限工作目录里读取整理好的输入并给出建议。PR 的最终审阅和合并由仓库维护者执行。

## 4. 交付物和安装

| 交付物 | 团队成员 | Curator 操作者 |
|---|---|---|
| **SuperWiki CLI 发布包** | 安装同一个 CLI。提供项目初始化、同步、记忆、收件和发布命令。 | 安装同一个 CLI。使用其中的 `curator` 子命令。 |
| **`superwiki-member` Skill** | 必装。定义开工查知识、收工 Dreaming、查收派单、回传和发布流程。 | 需要作为普通成员参与时安装。 |
| **`superwiki-curator` Skill** | 由 Curator 操作者安装。 | 必装。定义 Bounty 分类、成员匹配、起草和 PR 审阅。CLI 同时提供结构化输出 schema，供 runner 校验。 |
| **harness 适配器和项目模板** | Codex 适配器装 Skill 和 hook。其他 harness 使用对应适配器或通用 Skill 工作流。 | 安装项目模板，使用本机 Codex CLI 登录。在独立的 Curator 工作目录运行角色 Skill。 |

CLI 发布包随附两个 Skill、Codex hook 模板、GitHub Issue／PR 模板、Wiki 种子文件和命令参考。成员和维护者都在自己的机器上配置 `git` 及登录后的 `gh`。成员用自己的 GitHub 身份收件和提交。仓库维护者为成员开通读取 Wiki、回复 Issue 和提交分支或 PR 所需的权限。Curator 使用共享配置里指定的 GitHub 身份派单。团队发布包还应包含安装和升级说明。

### 团队成员安装和使用

解压 CLI 发布包，将 `superwiki` 加入 PATH，然后登录 GitHub、克隆项目并安装成员组件。

```powershell
gh auth login
gh auth setup-git
git clone https://github.com/acme/payments.git
Set-Location ./payments
superwiki install --role member --harness codex
superwiki doctor --role member
superwiki member run
```

`install` 建立本地项目记忆和配置，并将 Skill 安装到目标 harness 的本地发现路径。对于 Codex，Skill 安装在当前检出的 `.agents/skills/`，hook 安装时与已有本地配置合并，通过 `/hooks` 查看并信任。其他 harness 通过 `--harness generic` 取得通用 Skill 和 CLI 说明，再按该宿主的方式启用。`doctor` 检查 GitHub 身份、仓库、Skill 和本地记忆目录。成员在单独终端保持 `member run`，再打开自己平时用的 Agent。 [Codex Skill 安装位置](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) [Codex Hook 信任](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

### Curator 安装、配置和启动

维护者先安装 SuperWiki CLI 和 Codex CLI，然后登录并在独立检出目录安装 Curator。

```powershell
codex login
gh auth login
gh auth setup-git
git clone https://github.com/acme/payments.git payments-curator
Set-Location ./payments-curator
superwiki install --role curator --harness codex
```

共享配置 `superwiki.toml` 随项目提交。仓库标识从 `origin` 解析，成员收件箱使用默认分支配置中的 Curator 登录名校验派单。

```toml
[project]
wiki_branch = "main"
curator_login = "lin"
```

本机配置写入 `.superwiki/config.toml`。GitHub 凭证由 `gh` 或系统凭证存储提供。

```toml
[member]
github_login = "mei"
profile = "codex"
poll_seconds = 15

[curator]
codex_command = "codex"
fallback_assignee = "lin"
poll_seconds = 15
timeout_seconds = 120
```

配置好后，先试跑，再启动持续轮询。

```powershell
superwiki doctor --role curator
superwiki curator run-once --dry-run
superwiki curator run
```

`doctor` 根据当前 `origin` 核对 GitHub 仓库和 Curator 身份，检查分派、创建草稿 PR 所需权限以及 Codex 可用性。`run-once --dry-run` 打印处理计划。可以用 `curator run-once --issue 12 --dry-run` 或 `curator run-once --pr 17 --dry-run` 试跑单条。`curator run` 用当前配置持续轮询。Codex 的审阅会话使用专用配置和工作目录，由 runner 独立记录处理结果。

MVP 的持续运行由两个 CLI 命令承担。**成员的 `member run` 负责同步和收件，维护者的 `curator run` 负责派单和审阅。** 两个进程都可以前台启动。需要随登录启动时，可把相同命令交给操作系统调度。

## 5. 从空 GitHub 仓库冷启动

### 第一步是初始化项目

维护者创建一个空的私有 GitHub 仓库并开启 Issues，然后在本机初始化项目。

```powershell
gh auth login
gh auth setup-git
superwiki project init --remote https://github.com/acme/payments.git --path ./payments --harness codex --seed-bounties
Set-Location ./payments
superwiki doctor --role member
```

`init` 克隆仓库，初始化默认分支和 `wiki/` 骨架，写入共享配置、模板、`.gitignore` 和成员接入说明。它用 `--harness` 指定的适配器安装初始化者的团队 Skill，并在本地创建 `memory/index.md`、`notes/` 和 `transcripts/`。共享配置中的初始 Curator 身份取自当前 GitHub 登录，维护者可改成负责运行 Curator 的账号。首个模板提交由维护者账号发布。随后 CLI 创建所需标签和两条启动 Bounty。步骤使用固定的种子标识，重跑时检查已有提交和 Issue，接着完成剩余步骤。

`always-on.md` 初始只放已有依据的项目名称和工作约定，正文项目知识、成员能力和偏好由真实贡献填充。维护者发出项目仓库地址，邀请成员按第 4 节安装，再启动 Curator。成员第一次打开项目时，收件箱也展示尚未关闭的启动 Bounty，便于主动参与。

### 第二步是用两条 Bounty 填内容

| 启动 Bounty | 成员 Agent 怎么参与 | Curator 怎么整理 |
|---|---|---|
| **收集项目背景和初始化信息** | 结合本机能读到的 README、启动脚本、项目说明和已验证的做法，在 Issue 回复自己确认的部分。可提交项目目的、目录入口、开发启动步骤、常用命令、约定和常见问题，并附来源。 | 汇总重叠信息，追问缺项。把通用信息整理进 `wiki/always-on.md`，把具体做法放进 `wiki/domains/`，同时更新 `wiki/index.md`。 |
| **收集团队成员信息** | 成员让自己的 Agent 整理本人确认可分享的资料，包括 GitHub 登录名、前端或后端等擅长领域、愿意接的任务、可协审范围、工作偏好，以及是否有相应的 review 或 merge 权限。 | 按 GitHub 登录名生成 `wiki/members/<login>.md`，维护成员索引。初始成员资料用于后续派单。成员自述的审批或合并能力由维护者对照仓库权限和分支规则确认。 |

启动 Bounty 支持多人分批补充。初始没有成员资料时，Curator 配置中的维护者是默认接手人，其他成员可直接回复任一启动 Issue，也可以把已确认的一部分整理成小 PR。部分贡献用 `Refs #编号` 引用启动 Bounty。维护者确认首版信息齐备后，最终汇总 PR 才用 `Closes #编号`，合并时关闭对应 Bounty。后续新成员可单独提交资料，项目知识也走正常 Proposal 更新。

## 6. 日常交互和验收

| 用户对 Agent 说什么 | 预期结果 |
|---|---|
| “开始做这个项目的登录页，先查现有约定。” | Skill 调 `context`，先读当前 Wiki，再用项目本地笔记补充。 |
| “记一下这次解决构建缓存的做法。” | Agent 选本次任务的记录做 Dreaming，更新本地笔记和索引，返回笔记路径。 |
| “我们缺 Windows 的初始化步骤，帮我发 Bounty。” | Agent 查重后发 Issue，返回链接。Curator 扫到 Issue，分派给合适成员并留下期望结果。 |
| “查看派给我的任务，接手 #12。” | 成员 Agent 从本地收件箱和 GitHub 取到完整派单，查自己的项目资料，之后在原 Issue 回传。 |
| “把这次验证过的步骤分享给团队。” | Agent 准备团队版条目并开草稿 PR，Curator 给出审阅意见，维护者合并。 |

也可以在项目终端直接用 CLI 查知识、接单和回传。

```powershell
superwiki context --query "Windows 初始化步骤"
superwiki inbox
superwiki inbox show 12
superwiki inbox take 12
superwiki inbox reply 12 --body-file answer.md
superwiki proposal create --path wiki/domains/windows-setup.md --file team-note.md --body-file proposal.md
```

其中 `answer.md` 和 `team-note.md` 由成员 Agent 准备，`proposal.md` 说明修改原因和关联 Issue。日常在 harness 里用自然语言时，由团队 Skill 调用同一组命令。

MVP 验收用一个空仓库、两个成员 harness 和一台 Curator 电脑。初始化后应出现两条启动 Bounty。成员 A 完成任务后，关闭并重新打开会话，仍能读到该项目本地笔记。A 再发一条 Bounty，Curator 扫到它并在 GitHub 派给 B，B 的 harness 通过 hook 或收件命令收到任务。B 在原 Issue 回复，维护者合并关联的 Proposal，A 的本地 Wiki 刷新到合并后的 SHA，并从 `context` 读到新知识。额外检查一次离线恢复，确认待办和 Wiki 能追上，重复执行同一输入只产生一轮派单或审阅。
