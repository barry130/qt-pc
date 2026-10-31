# 共享 UI 组件（写界面前先查这里）

> 结论先放前面：**页面里不要自己画基础控件**。按钮、输入框、开关、分段、弹窗、空态、
> 骨架、设置行、加载指示器都已有唯一实现，从 `@/components/ui` 导入即可。
> 新增一份 `<button className="rounded-md border ...">` 就是在制造下一条债务。

## 0. 三条规则

1. **先查本文件**：写页面前在这一页搜一遍要用的交互，能找到就直接用；找不到再往下走 2。
2. **新组件进 `src/components/ui/`**：确实缺一种交互时，新建 `ui/xxx.tsx` → 在 `ui/index.ts` 导出 →
   在本文档登记。**不要**塞进某个页面文件里当「局部组件」（正是这样长出了 66 种按钮外观）。
3. **页面只做业务**：页面文件里出现 `fixed inset-0 bg-black/40`、`rounded-md border border-border px-3 py-1.5`、
   `h-3.5 w-3.5 animate-spin`、`py-10 text-center text-sm text-muted-foreground` 这类基础外观，
   都说明该用下面的组件（或说明本层还缺一个）。

历史入口仍可用（`@/components/common/*`、`@/components/settings/controls`），内部已转调本层；
**新代码统一从 `@/components/ui` 导入**。

## 1. 组件清单

### 1.1 按钮与状态

| 组件 | 用途 | 关键点 |
| --- | --- | --- |
| `Button` | 唯一的文字按钮 | `variant`：`primary` 一屏一个主操作 / `secondary`（默认）/ `outline` 次级 / `ghost` 工具条 / `danger` 破坏性 / `link` 文字链；`size`：`xs` 26px 表格行内、`sm` 32px 默认、`md` 36px、`lg` 40px 表单主按钮；`shape`：`rect` / `pill` 浮层 / `block` 撑满；`loading` 自动禁用+转圈；图标走 `icon` / `iconRight`，别在 children 里塞 `<svg>` |
| `buttonClass()` | 给 `<a>` / 路由 `<Link>` 套同一套外观 | `buttonClass({ variant: "outline" })`；**不要**手抄类名 |
| `IconButton`（common） | 纯图标按钮 | 必须给 `label`（读屏 + 悬浮提示）；`size` `sm/md/lg`；`danger` 悬停变红 |
| `Badge` | 标签 / 计数 / 状态 | `tone`：`neutral` / `primary` / `success` / `danger` / `outline`；可带 `icon` |
| `Spinner` | 局部加载指示 | `size`：`xs`/`sm`/`md`/`lg`；`role="status"`；按钮内加载直接用 `Button loading`，别自己塞图标 |
| `LoadingState` | **没有形状可占位**的加载中（弹层内容、弹窗里的子页面） | 转圈 + 「加载中…」一行，`label` 换成场景文案（「正在读取报告…」）；`role="status"` 自带播报。**列表页 / 网格页不要用它**——用骨架屏，否则数据到达时「一行小字 → 一整屏内容」会跳一下 |
| `EmptyState`（common） | 空态 | `title` 必填，`description` 给下一步，`action` 给出口；`variant` `plain`（列表内） / `block`（整页或卡片位）；`tone="destructive"` 表示错误而非空 |
| `RowsSkeleton` | **列表页首次加载态**（曲目 / 歌单 / 下载 / 消息 / 文件夹） | `rows` 行数；`cover` `square`（曲目、歌单）/ `circle`（歌手）/ `none`（纯文本行）；`coverSize` 默认 36；`label` 是读屏播报（默认「正在加载…」）；骨架本体 `aria-hidden` |
| `GridSkeleton` | **网格页首次加载态**（榜单 / 歌单广场 / 有声榜） | `count` 块数；`minTile` 最小列宽（默认 128，宽卡片给 220）；`padded` 默认自带 `p-4`，容器已有内边距时传 `false` |
| `Skeleton` | 单块占位（自定义形状时自己拼） | 只有 `className`，已带 `animate-pulse rounded bg-secondary`，别手写这三样 |
| `TrackRowsSkeleton` / `CoverGridSkeleton`（discovery/Skeletons） | 旧名，形状已委托给上面两个 | 新代码直接用 `RowsSkeleton` / `GridSkeleton` |
| `LoadBar` / `ListLoadProgress` / `ErrorRetry`（discovery/Skeletons） | 一次性加载进度、底部已加载条数、错误重试 | 数据已在屏上、只是还在换档 / 续拉时用它，**不要再叠骨架**（会闪） |

### 1.2 表单

| 组件 | 用途 | 关键点 |
| --- | --- | --- |
| `Field` | 表单行的标签 + 提示 + 错误 | 自动用 `useId` 生成 id 并注入给子控件（`aria-describedby` / `aria-invalid`），不要再手写 `htmlFor` |
| `Input` / `Textarea` / `Select` / `Checkbox` | 唯一的输入控件 | `controlSize`：`xs` 26px / `sm` 32px / `md` 36px；`Checkbox` 可带 `label`（点文字也能勾） |
| `FormRow` | 设置项「左标题+说明、右控件」 | 右列已约束 `max-w-[60%]`；设置页里历史名字叫 `SettingRow`（同一实现） |
| `Switch` | 开关 | `role="switch"` + `aria-checked`；`label` 用于读屏 |
| `Segmented` | 分段选择 | `role="radiogroup"`；`block` 撑满；选项是 `{value,label}[]` |
| `DirPicker` / `NumberField` / `ExternalLinkButton`（settings/controls） | 目录选择、数字输入、外链按钮 | 设置页专用，已基于 `Button` / `Input` |

### 1.3 弹层

| 组件 | 用途 | 关键点 |
| --- | --- | --- |
| `Modal` | **唯一的对话框外壳** | `useFocusTrap` 管 Tab 循环 / Esc（Esc 同时挂到 document，焦点跑到外面也能关）/ 关闭后归还焦点；`createPortal` 到 `body`（不会被滚动容器的 `overflow` / `transform` 裁切）；`size` `sm` 24rem / `md` 28rem / `lg` 42rem / `xl` 56rem；`tone` `card`（跟随主题）/ `glass`（半透明玻璃，导入歌单、更新弹窗用）；`dismissible={false}` 关掉 Esc 与 ×；`closeOnBackdrop` 控制点遮罩；`title` / `description` / `icon` 走标准 header，`footer` 固定在底部，children 是滚动区；`closeLabel` 定制读屏文案；`headerLeft` 放返回键之类（一层层往里钻的弹层），`footerClassName` 覆写底部布局（`justify-between` 做「左统计右翻页」） |
| `ConfirmDialog` | 二次确认（删除、退出、覆盖安装） | 只有取消 / 确认两个出口；`tone="danger"` 用于破坏性操作且**不会**自动聚焦确认键（防手快回车） |
| `Popover` | 锚定浮层（菜单、筛选、消息列表） | 支持受控 `open` / `onOpenChange`，可程序化打开 |

### 1.4 布局与内容

| 组件 | 用途 |
| --- | --- |
| `PageContainer`（layout） | 页面骨架：`flex h-full min-w-0 flex-col` + 固定标题 + `stickyHeader` + 可滚动内容区 |
| `DetailHero` + `HeroBackdrop` / `HeroCover` / `HeroEyebrow` / `HeroTitle` / `HeroMeta` / `HeroPlayButton` | 详情页 Hero（专辑 / 歌手 / 日报 / 歌单）：模糊封面铺底、封面块、小字、标题、统计行、播放键一次给齐；`DetailHero` 本身**不裁切**（批量条要 absolute 展开） |
| `SectionHeader` | 区块标题（`eyebrow` 小字 / `title` / `description` / `actions`；`size` `page` 与 `section`） |
| `Card` | 带边框的容器（`padding` `none` / `sm` / `md`；`as` 换语义标签） |
| `RowActions` / `BatchDeleteButton`（common） | 列表行悬停操作、批量删除按钮 |
| `SourceTag` / `ArtistAvatar`（common） | 音源角标、歌手头像（尺寸 / 平台已内建） |
| `Hint` / `ContextMenu`（common） | 行内提示、右键菜单 |
| `CommandPalette` / `ToastHost` / `ErrorBoundary` / `FirstRunDisclaimer`（common） | 全局设施，页面一般不直接用 |

## 2. 常见页面的组装范式

**列表页**

```
PageContainer title="我的歌单"
  ├─ 工具条：Input（搜索）+ Segmented（排序）+ Button variant="outline"（筛选）
  ├─ 首次加载：RowsSkeleton（网格页用 GridSkeleton）
  ├─ 有空数据但正在换档：保留旧内容 + 压暗 + LoadBar，别清空重画（清空会在滚动容器里闪一下）
  ├─ 空：EmptyState variant="plain" action={<Button>…</Button>}
  └─ 错误：ErrorRetry
```

**详情页头部**：背景图 + `SectionHeader`（`size="page"`）+ 操作按钮组（`Button shape="pill"`）；
不要再手写 `absolute inset-0 blur-3xl saturate-150` 那一整块渐变。

**设置页**：`PageContainer` + `Card padding="none"` 包裹多个 `FormRow`；行内控件用 `Switch` / `Segmented` / `NumberField`。

**弹窗**：`Modal`（必要时 `ConfirmDialog`）；内容里的按钮一律 `Button`，不要自己拼 `rounded-md px-3 py-1.5`。

**浮层里的按钮**（更新提示、公告条）：`Button shape="pill"`。

## 3. 令牌与动效约束（`npm run check` 会拦）

- 字号只用令牌：`text-2xs`（11px）、`text-xs`、`text-sm`…；**禁止** `text-[13px]` 这类任意值。
- 动画时长用 `duration-fast` / `duration-base` / `duration-slow`；**禁止** `duration-300`。
- 缓动用 `ease-soft` / `ease-expo`；**禁止** `ease-in` / `ease-out` / `ease-in-out`。
- 阴影用 `shadow-surface` / `shadow-raised` / `shadow-overlay`；颜色用 `--color-*` 令牌，不要新写十六进制。
- 形状令牌在 `src/index.css` 的 `@theme inline`；`cn()` 在 `src/lib/utils.ts`。

## 4. 迁移状态

已改用共享层：

- 设置页全部行控件（`SettingRow` / `Switch` / `Segmented` / `DirPicker` / `NumberField` / `ExternalLinkButton`）。
- 对话框：`SourceUpdatePrompt`、`MetaPackGuide`、`SourcePackageSection`（剪贴板提示 + 安装预览）、
  `SourceAccountsPage`（扫码 / Cookie / 短信 / 密码四个登录弹窗）、`ImportPlaylistDialog`、
  `SourcePlaylistSyncDialog`、`UpdateDialog`、`AiProvidersDialog`。
- 加载指示器：原本 17 处手写 `<Loader2 className="h-3.5 w-3.5 animate-spin" />` 已换 `Spinner`。
- 弹窗内与账号页里重复的次级 / 主按钮类名改用 `buttonClass({ variant })`，外观回到唯一来源。
- 整块加载态：26 处「`py-10/16 text-center text-sm text-muted-foreground` + 灰字」换成 `EmptyState`（空）与 `LoadingState`（正在加载）。
- 骨架屏收敛到 `ui/skeleton.tsx`（`RowsSkeleton` / `GridSkeleton` / `Skeleton`），`discovery/Skeletons.tsx` 只留薄包装；「本地音乐 / 最近播放 / 下载管理 / 我的歌单 / 本地文件夹 / 排行榜 / 有声榜 / 消息」八处原先把转圈当整页加载态，已改成与内容同形状的骨架。
- 详情页 Hero 五处（`AlbumPage` / `ArtistPage` / `DailyPage` / `DailyRecommendPage` / `PlaylistDetailPage`）改用 `DetailHero` 与 hero 零件，模糊封面那块不再逐字重复。
- `components/mine/ListenReportDetail.tsx` 换成 `Modal`（`headerLeft` 放「返回上一层」、`footerClassName="justify-between"` 做左统计右翻页），顺带删掉自写的 `createPortal` 与焦点陷阱。

| 听歌报告排序切换 | `Segmented`（原 `aria-pressed` 改为 `radiogroup` / `radio`，读屏念法更准） |
| 听歌趋势的两组档位 | 用共享 `Segmented`（此前是页面内私有实现）；换档不再清空内容，改为「旧内容压暗 + 顶部 `LoadBar`」，消除屏闪 |

尚未迁移（下一批做，改动前先看清业务差异）：

| 位置 | 现状 | 计划 |
| --- | --- | --- |
| 其余 `<button>` 外观 | 仍有若干一次性类名（列表行、标签切换） | 逐页换 `Button` / `buttonClass`，不要新增 |

## 5. 加新组件的流程

1. 先确认本文件里没有等价物（等价就看能不能加一个 `variant`，而不是新建组件）。
2. 新建 `src/components/ui/xxx.tsx`：props 用显式接口、注释写清「为什么收口」、不引入业务依赖（store / ipc 一律不进 ui 层）。
3. 在 `src/components/ui/index.ts` 导出。
4. 在本文档第 1 节登记一行（用途 + 关键 props + 不该用的地方）。
5. 至少补一个测试（`tests/ui-*.test.tsx`），跑 `npm run check`。
