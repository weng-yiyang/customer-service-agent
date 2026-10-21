# 智能客服 Agent（小云）

一个支持多轮对话、FAQ 检索、意图识别、自动转人工、对话持久化与管理后台的客服 Web 应用。
当前交付为**本地回退演示版**：用 `localStorage` 持久化对话、用内置规则引擎代替云端大模型，
可直接本地运行与发布演示；已内置**云端就绪开关**，开通 WorkBuddy 云端后即可一键切换真大模型 + 云数据库。

## 功能对照（覆盖全部原始需求）

| 需求 | 实现 |
|---|---|
| 多轮对话 | 会话内维护消息历史，刷新不丢（localStorage + sessionStorage）；支持多轮意图继承 |
| FAQ 知识库检索 | `engine.js` 关键词检索 `faq-data.js` 知识库，取 Top-3 注入回答；知识库可由后台动态维护 |
| 自动识别意图 | `classifyIntent`：退款 / 查询订单 / 技术支持 / 其他（已修复"人工智能"等误触发） |
| 自动转人工 | 命中"转人工/人工客服"等强信号时转人工，收集联系方式并标记状态 |
| 对话历史持久化 | `store.js` 落地到 localStorage（云端版落地到云数据库） |
| 管理后台 | `admin.html`：对话列表、按意图/状态/日期筛选、详情、满意度统计、CSV 导出、FAQ 管理、人工回复 |
| 数据存云端 | 预留 `cloud.js`：注入 `CLOUD_CONFIG` 后改用云数据库 |
| 接入大模型 | 预留 `cloud.js`：免密钥大模型（意图分类 + 流式生成回答） |
| 发布上线 | 静态站点，可一键发布（见下） |

## 本次补齐的能力（B 类缺口）

- **P0 闭环**
  - 转人工后可在后台**人工回复**，顾客端每 3 秒轮询自动显示人工消息（演示版同浏览器 localStorage 共享）。
  - 新增 **`resolved`（已解决）** 状态：顾客评分后或后台"标记为已解决"即置为已解决。
- **P1 增强**
  - **FAQ 管理后台**：列表 / 新增 / 编辑 / 删除知识库条目，实时生效（引擎统一从 `CS_GET_FAQ` 取数）。
  - **意图识别鲁棒性**：转人工改用强信号词表，避免"人工智能""客服时间"误触发；扩充同义词。
  - **日期范围筛选 + CSV 导出**：后台可按起止日期过滤并导出对话记录。
  - **输入安全**：用户输入超长截断（500 字）、发送频率限制（60 秒 20 条）、用户消息落库前自动脱敏（手机号/邮箱）。
- **P2 体验**
  - **1-5 星满意度**替代原 👍/👎，统计平均星与好评率（4-5 星）。
  - **多轮意图继承**：当前弱意图时沿用历史最近一条强意图。
  - 移动端响应式 + 基础无障碍（`role="log"` / `aria-live` / 星级 `aria-label`）。

## 本地运行

直接用浏览器打开 `index.html`（顾客端）与 `admin.html`（管理后台）即可。
若浏览器对多文件加载有限制，可在目录内起一个静态服务：

```bash
python -m http.server 8080
# 然后访问 http://localhost:8080/index.html
```

> 管理后台默认口令 `admin888`（演示用，生产请改为云端账号认证，见下）。

## 云端升级（切换到真大模型 + 云数据库）

1. 在 WorkBuddy 开通云端（云数据库 + 免密钥大模型 + 认证）。
2. 在云数据库执行下面的建表 SQL（含 RLS 与授权）。
3. 把开通后得到的 `publicConfig` 注入页面，例如在各 HTML 的 `<script>` 之前加：

```html
<script>
  window.CLOUD_CONFIG = {
    endpoint: "https://xxxx.workbuddy.link",
    publishableKey: "pub_xxxx",
    oauthRelayBaseUrl: "https://relay.workbuddy.link"
  };
</script>
```

`cloud.js` 检测到 `CLOUD_CONFIG` 后会自动覆盖 `CS_STORE` / `CS_ENGINE`，业务代码无需改动。

### 建表 SQL（conversations / messages / faqs + RLS）

```sql
-- 会话表
CREATE TABLE conversations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT,
  intent TEXT DEFAULT 'other',
  status TEXT DEFAULT 'ai',
  satisfaction SMALLINT,
  contact JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 消息表
CREATE TABLE messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 知识库表
CREATE TABLE faqs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category TEXT,
  question TEXT,
  answer TEXT,
  keywords TEXT[]
);

-- 授权（migrate 角色执行）
GRANT SELECT, INSERT, UPDATE ON conversations, messages, faqs TO anon, authenticated;

-- RLS：匿名仅可写入（顾客对话落库），管理员（已登录）可读全部
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;

CREATE POLICY conv_anon_insert ON conversations FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY conv_auth_select ON conversations FOR SELECT TO authenticated USING (true);
CREATE POLICY msg_anon_insert ON messages FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY msg_auth_select ON messages FOR SELECT TO authenticated USING (true);
CREATE POLICY faq_public ON faqs FOR SELECT TO anon, authenticated USING (true);

-- 种子 FAQ（把 faq-data.js 的内容同步进库，或用管理后台维护）
-- INSERT INTO faqs (category, question, answer, keywords) VALUES (...);
```

## 发布上线

在 WorkBuddy 中使用"发布为应用"能力，将本目录作为静态站点发布即可获得在线访问链接。
发布后访问 `<域名>/index.html` 为顾客端，`<域名>/admin.html` 为管理后台。

## 演示版局限（上线前须知）

- **数据隔离**：演示版用浏览器 `localStorage`，管理后台只能看到本机本浏览器的对话。
  真实多用户场景必须走云端数据库（见上方升级步骤）。
- **大模型**：演示版的回答来自规则引擎 + FAQ，并非真大模型；升级云端后即变为真 LLM。
- **后台鉴权**：演示版为前端口令，仅用于演示；生产请改用云端认证（WorkBuddy 账号登录）。

## 目录结构

```
customer-service-agent/
├── index.html        # 顾客聊天页
├── admin.html        # 管理后台
├── styles.css        # 统一样式
├── js/
│   ├── faq-data.js   # 示例 FAQ 知识库（云端就绪后由 faqs 表接管）
│   ├── store.js      # 持久化层（localStorage / 动态 FAQ / 脱敏）
│   ├── engine.js     # 智能引擎（意图/检索/应答，本地规则）
│   ├── cloud.js      # 云端接入（SDK，云端就绪开关）
│   ├── app.js        # 聊天页逻辑（评分/转人工闭环/轮询/安全）
│   └── admin.js      # 后台逻辑（筛选/导出/FAQ 管理/人工回复）
├── test/
│   ├── local-test.js # 核心逻辑测试（意图/FAQ/存储/统计/闭环）
│   ├── dom-smoke.js  # 模块加载与首屏冒烟
│   └── flow-test.js  # 顾客端关键点击流集成测试
└── README.md
```

## 本地测试

无需浏览器/构建，直接用 Node 运行：

```bash
node test/local-test.js   # 40 项核心逻辑断言
node test/dom-smoke.js    # 模块加载与首屏渲染冒烟
node test/flow-test.js    # 发送/转人工/5 星评分/人工回复轮询 集成流
```
