import { writeFileSync } from 'node:fs'

export default {
  id: '__MODULE_ID__',
  name: 'Host contract fixture',
  version: '1.0.0',
  api: 1,
  defaults: { credential: '' },
  settings: [{ key: 'credential', label: 'Fixture credential', type: 'password' }],
  setup(api) {
    writeFileSync(api.dataDir('owned.txt'), api.id, 'utf8')
    api.on('host-contract:tick', () => {
      globalThis.__hostContractEvents = (globalThis.__hostContractEvents || 0) + 1
    })
    api.onDispose(() => {
      globalThis.__hostContractOffCalls = (globalThis.__hostContractOffCalls || 0) + 1
    })
    return {
      dataPath: (...parts) => api.dataDir(...parts),
      sendText: (chatId, text) => api.sendText(chatId, text),
      sendRaw: (chatId, params) => api.onebot('send_private_msg', params, { timeoutMs: 5000 }),
      dispose() {
        globalThis.__hostContractDisposeCalls = (globalThis.__hostContractDisposeCalls || 0) + 1
      },
    }
  },
}
