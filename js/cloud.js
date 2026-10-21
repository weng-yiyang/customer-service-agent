/* =========================================================================
 * cloud.js — 云端接入（WorkBuddy Cloud Service）
 * -------------------------------------------------------------------------
 * 本文件为"云端就绪"代码：仅当页面设置 window.CLOUD_CONFIG（由开通云端后注入的
 * publicConfig）时才会启用，届时自动切换为【真大模型 + 云数据库】，无需改动业务代码。
 *
 * 启用步骤（详见 README.md）：
 *   1) 在 WorkBuddy 开通云端（云数据库 + 免密钥大模型 + 认证）；
 *   2) 在云数据库执行 README 中的建表 SQL（conversations / messages / faqs + RLS）；
 *   3) 将 publicConfig 注入为本页的 window.CLOUD_CONFIG，并设置 window.CS_CLOUD_READY。
 *
 * 本文件提供：
 *   window.CS_CLOUD_STORE   —— 与 store.js 完全一致的异步接口（云数据库实现）
 *   window.CS_CLOUD_ENGINE  —— 与 engine.js 完全一致的接口（免密钥大模型实现）
 * ========================================================================= */

(function () {
  const cfg = window.CLOUD_CONFIG;
  if (!cfg || !cfg.endpoint || !cfg.publishableKey) {
    // 未配置云端：保持本地演示引擎/存储（store.js / engine.js 已默认设置）
    return;
  }

  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function init() {
    await loadScript(SDK_URL);
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      oauthRelayBaseUrl: cfg.oauthRelayBaseUrl || '',
      publishableKey: cfg.publishableKey,
    });

    // ---------- 云存储实现 ----------
    const CloudStore = {
      async createConversation({ sessionId, intent = 'other' }) {
        const { data, error } = await cloud.database
          .from('conversations')
          .insert({ session_id: sessionId, intent, status: 'ai' })
          .select()
          .single();
        if (error) throw error;
        return normalizeConv(data);
      },
      async getConversation(id) {
        const { data } = await cloud.database
          .from('conversations')
          .select('*, messages(*)')
          .eq('id', id)
          .maybeSingle();
        return data ? normalizeConv(data) : null;
      },
      async appendMessage(id, role, content) {
        await cloud.database.from('messages').insert({ conversation_id: id, role, content });
        const { data } = await cloud.database
          .from('conversations')
          .select('*, messages(*)')
          .eq('id', id)
          .single();
        return normalizeConv(data);
      },
      async updateConversation(id, patch) {
        const { data } = await cloud.database
          .from('conversations')
          .update(patch)
          .eq('id', id)
          .select('*, messages(*)')
          .single();
        return normalizeConv(data);
      },
      async listConversations() {
        const { data } = await cloud.database
          .from('conversations')
          .select('*, messages(*)')
          .order('updated_at', { ascending: false });
        return (data || []).map(normalizeConv);
      },
      async getStats() {
        const list = await this.listConversations();
        const byIntent = {}, byStatus = {};
        const satDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        let satCount = 0, satSum = 0;
        const byDay = {};
        for (const c of list) {
          byIntent[c.intent] = (byIntent[c.intent] || 0) + 1;
          byStatus[c.status] = (byStatus[c.status] || 0) + 1;
          if (typeof c.satisfaction === 'number' && c.satisfaction >= 1 && c.satisfaction <= 5) {
            satCount++; satSum += c.satisfaction; satDist[c.satisfaction]++;
          }
          const day = (c.createdAt || '').slice(0, 10);
          if (day) byDay[day] = (byDay[day] || 0) + 1;
        }
        const satAvg = satCount ? Math.round((satSum / satCount) * 100) / 100 : null;
        const satisfied = satDist[4] + satDist[5];
        const satRate = satCount ? Math.round((satisfied / satCount) * 100) : null;
        return { total: list.length, byIntent, byStatus, satCount, satAvg, satRate, satDist, byDay };
      },
    };

    function normalizeConv(r) {
      return {
        id: r.id,
        sessionId: r.session_id,
        intent: r.intent,
        status: r.status,
        satisfaction: r.satisfaction,
        contact: r.contact,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messages: (r.messages || []).map((m) => ({ role: m.role, content: m.content, ts: m.created_at })),
      };
    }

    // ---------- 云引擎实现（免密钥大模型） ----------
    async function pickModel() {
      const models = await cloud.llm.models.list();
      return models.find((m) => m.disabled !== true) || models[0] || null;
    }

    async function streamCollect(messages) {
      const model = await pickModel();
      if (!model) throw new Error('当前应用未启用任何大模型');
      let text = '';
      for await (const chunk of cloud.llm.chat.completions.create({
        model: model.id,
        messages,
        stream: true,
        temperature: 0.3,
      })) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) text += delta;
      }
      return text;
    }

    const CloudEngine = {
      async classifyIntent(text) {
        const sys =
          '你是一个客服意图分类器。只能输出 JSON：{"intent":"refund|order|tech|other","score":0-10}。' +
          'refund=退款, order=查询订单/物流, tech=技术支持, other=其他。不要输出多余内容。';
        const out = await streamCollect([
          { role: 'system', content: sys },
          { role: 'user', content: text },
        ]);
        try {
          const j = JSON.parse(out);
          return { intent: j.intent || 'other', score: Number(j.score) || 0 };
        } catch (e) {
          return { intent: 'other', score: 0 };
        }
      },
      async retrieveFAQ(text, topK = 3) {
        // 云端：直接从 faqs 表做关键词/全文检索
        const { data } = await cloud.database
          .from('faqs')
          .select('*')
          .or(`question.ilike.*${text}*,answer.ilike.*${text}*`)
          .limit(topK);
        return (data || []).map((f) => ({ faq: f, score: 3 }));
      },
      async generateReply(text, history) {
        const faqs = await this.retrieveFAQ(text, 3);
        const sys =
          '你是"小云"智能客服。语气友好、简洁、专业。' +
          '优先依据【知识库】回答；知识库不足时，结合对话历史合理推断并礼貌引导用户补充信息或转人工。' +
          '不要编造政策与价格。若用户明确要求人工，请在结尾提示已转人工。';
        const msgs = [{ role: 'system', content: sys }];
        for (const m of history || []) msgs.push({ role: m.role, content: m.content });
        msgs.push({ role: 'user', content: text });
        if (faqs.length) {
          const kb = faqs.map((f) => 'Q:' + f.faq.question + '\nA:' + f.faq.answer).join('\n\n');
          msgs.push({ role: 'system', content: '【知识库参考】\n' + kb });
        }
        const reply = await streamCollect(msgs);
        const transfer = /转人工|人工客服|真人/.test(text);
        const { intent } = await this.classifyIntent(text);
        return { reply, intent, faqs, transfer };
      },
    };

    window.CS_CLOUD_STORE = CloudStore;
    window.CS_CLOUD_ENGINE = CloudEngine;
    window.CS_STORE = CloudStore; // 覆盖 store.js 的本地默认
    window.CS_ENGINE = CloudEngine; // 覆盖 engine.js 的本地默认
    window.CS_CLOUD_READY = true;
    if (window.__onCloudReady) window.__onCloudReady();
  }

  init().catch((e) => {
    console.warn('[cloud.js] 云端初始化失败，已回退本地演示模式：', e);
  });
})();
