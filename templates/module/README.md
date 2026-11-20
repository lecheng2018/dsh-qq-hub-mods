# 示例模块

此目录是未发布的开发模板，不在 `modules/` 下，不会进入市场。复制到 `modules/<实际-id>/` 后，替换清单和入口中的 id、名称、描述、作者，以及 LICENSE 中的版权主体；同步修改测试名称和工具名。

```sh
node --test templates/module/module.test.mjs
```

复制后的测试入口保留 `*.test.mjs`。模板默认关闭，不依赖外部服务，不发送消息，不写私有数据；execute 会再次检查开关并校验参数。新增敏感能力时另做执行侧鉴权，不得将模板视为完整权限实现。

开发和评审要求见 [开发指南](../../CONTRIBUTING.md) 与 [硬性要求](../../docs/MANDATORY_REQUIREMENTS.md)。清单在模板原位置的 schema 路径，以及复制到 `modules/<id>/` 后的路径，均为 `../../schemas/module.schema.json`。
