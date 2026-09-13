# API & DB Schema Tools v0.7.2

Schema Studio 用于维护接口字段和数据库字段。底层仍然是普通 Markdown + YAML Frontmatter + Wikilink，Fileclass 提供属性定义，Schema Tools 负责 JSON/DDL 导入、字段管理和精准引用。


## Installation / 安装

Download `main.js`, `manifest.json`, and `styles.css` from the matching [GitHub release](https://github.com/humoumou1215/api-db-schema-tools/releases). Place them in `<vault>/.obsidian/plugins/api-db-schema-tools/`, reload Obsidian, and enable **API & DB Schema Tools** under **Settings → Community plugins**. Fileclass is optional but provides the property definitions used by the schema views.

## Usage / 使用

Open the command palette and run **打开 Schema Studio** to browse and edit schema fields. Use **安装 / 打开体验样例** for a reversible demo, then use **退出体验样例并恢复插件配置** when finished. JSON and DDL import actions are available from the corresponding schema views.

## v0.7.2：社区发布准备

- 补充安装与使用说明。
- Release 工作流为安装资产生成 GitHub artifact attestations。

## v0.7.1：体验样例中文化

一键安装的体验样例现在以中文内容为主：

- 接口名称、接口文档、设计文档和字段说明使用中文。
- JSON 样例中的姓名、商品、颜色、优惠券、支付方式、状态、地址等值使用中文。
- DDL 注释和样例文件名使用中文。
- 体验 Fileclass 类名改为“体验接口字段 / 体验数据库字段”。
- `buyer.user_id`、`orders.user_id`、`Request/Response` 等协议/数据库技术标识仍保留，避免样例失真。

## v0.7.0：一键安装体验样例

第一次安装插件后，可以通过命令面板（Ctrl/Cmd+P）运行：

**API & DB Schema Tools: 安装 / 打开体验样例**

安装前会显示完整影响范围，包括：

- Vault 根目录只新增一个 `_SchemaTools-Demo/` 目录，所有样例文件都放在这个目录内。
- 将临时修改 Schema Tools 的接口文档、数据库文档、接口字段、数据库字段、Base 路径。
- 如果已安装 Fileclass，会明确显示并临时修改 **Class files folder** 到 `_SchemaTools-Demo/_fileclasses/`。
- 不移动、不覆盖、不删除现有业务文件。
- 安装前的插件配置会自动备份。

样例覆盖：

- 复杂 JSON Object / List<Object> 接口字段。
- 接口和数据库精确 `[[@` 分层引用。
- Fileclass + Bases 字段维护。
- JSON 文件/字符串导入与重导入 Diff。
- MySQL / Oracle DDL 示例。
- Excel/WPS 多单元格复制粘贴。
- Schema Studio 排序、筛选、属性、搜索和新建。

体验结束后运行：

**API & DB Schema Tools: 退出体验样例并恢复插件配置**

该命令只恢复插件配置，不自动删除 `_SchemaTools-Demo/`，避免误删你在样例中做的修改。

> 如果 `_SchemaTools-Demo/` 已存在，安装命令不会覆盖其中任何文件，只提供“打开现有样例”。

## v0.6.2：Esc 分层与未保存保护

- 单元格正在编辑时，第一次 Escape **只取消当前单元格编辑**，不会关闭 Schema Studio。
- 没有活动编辑器但存在 pending edits 时，Escape 或右上角 X 会显示未保存提示。
- 未保存提示提供 **保存并关闭 / 不保存 / 取消**；Enter 或 Ctrl/Cmd+S 保存并关闭，Escape 取消关闭。
- Schema Studio 浏览页支持 Ctrl/Cmd+S 直接保存当前 pending edits。
- 所有关闭入口统一走 dirty guard，避免通过 Modal 原生 Escape 绕过保存检查。

## 字段视图与编辑

字段表上方提供：**排序 / 筛选 / 属性 / 搜索 / 新建**。

- 单击选择单元格。
- 双击文本/数字单元格进入编辑；不会全选原内容，光标尽量放在双击位置。
- Enter 提交当前单元格。
- Escape 取消当前单元格编辑。
- Boolean：双击 / Enter / 空格直接 `true ↔ false`。
- 方向键移动单元格；Ctrl/Cmd + 方向键滚动表格窗口。
- 手工编辑与 JSON/DDL 导入共用 Pending Change：显示 `~~旧值~~ → 新值`，顶部一次保存。

## Excel / WPS

支持矩形区域 TSV 复制粘贴，也支持带 Fileclass 属性名表头的按列名映射。

## JSON / DDL 导入

- JSON 字符串、单文件、多文件批量导入。
- 文件名或 `__schema` / `_schema` 元信息自动路由。
- MySQL、Oracle DDL adapter，后续方言可继续注册 adapter。
- Diff 直接显示在同一字段 Grid 中。
- 源中消失字段只标记 `schema_orphaned`，不直接删除 Markdown 文件。

## 精准引用

输入：

```text
[[@
```

进入接口 / 数据库逐层联想；普通 `[[` 仍由 Obsidian 原生 Wikilink 处理。

## 隐私与许可

API & DB Schema Tools 不发起网络请求、不包含遥测、不要求账户或付费服务。它只通过 Obsidian API 读写 Vault 内的 Markdown、YAML Frontmatter 和用户主动选择导入的内容。体验样例安装会先展示并备份将要修改的插件配置，且不会覆盖或删除已有文件。项目采用 [MIT License](LICENSE)。
