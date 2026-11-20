export default {
  id: 'example-module',
  name: '示例模块',
  version: '1.0.0',
  description: '复制模板后替换 id、名称、描述和作者',
  api: 1,
  defaults: { enabled: false },
  settings: [{ key: 'enabled', label: '启用', type: 'switch' }],
  setup(api) {
    api.tool(() => api.settings().enabled ? [api.defineTool({
      name: 'example_echo',
      description: '返回经过校验的文本，不发送消息、不读取私有数据',
      properties: { text: { type: 'string', description: '不超过 200 字符的文本' } },
      required: ['text'],
      execute: async ({ text } = {}) => {
        if (!api.settings().enabled) return { ok: false, message: '模块未启用' };
        if (typeof text !== 'string' || text.length > 200) {
          return { ok: false, message: 'text 必须为不超过 200 字符的字符串' };
        }
        return { ok: true, message: text };
      },
    })] : []);
  },
};
