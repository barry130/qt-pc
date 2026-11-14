import { useState } from "react";
import { ExternalLink, GitBranch, Github } from "lucide-react";
import { BackButton } from "@/components/layout/BackButton";
import * as ipc from "@/services/ipc";

/** 反馈渠道（2026-11-14 用户裁定：入口只留双仓 Issue）：
 *  CNB = 主开发仓（推送远端），GitHub = 镜像仓。 */
const ISSUE_CHANNELS = [
  {
    key: "cnb",
    name: "在 CNB 提交 Issue",
    host: "cnb.cool/canace/qt-pc",
    url: "https://cnb.cool/canace/qt-pc/-/issues/new",
    icon: GitBranch,
  },
  {
    key: "github",
    name: "在 GitHub 提交 Issue",
    host: "github.com/barry130/qt-pc",
    url: "https://github.com/barry130/qt-pc/issues/new",
    icon: Github,
  },
] as const;

/**
 * 意见反馈首页（路由 /feedback）：双仓 Issue 入口。
 *
 * 2026-11-14 起（用户裁定）页面只保留「CNB / GitHub 提交 Issue」两个外部
 * 入口，点击交系统默认浏览器打开（openExternalUrl）。原先的「我的反馈 /
 * 公开反馈」双 Tab 查询列表与「写反馈」入口整体停用——旧实现**代码未删**，
 * 逐行注释保留在文件底部 Legacy 区；恢复内置反馈时去掉注释并换回导出名即可
 * （/feedback/submit 与 /feedback/$id 路由未动，随时可接回）。
 */
export function FeedbackListPage(): React.JSX.Element {
  const [openFailed, setOpenFailed] = useState<string | null>(null);

  const openChannel = async (url: string, name: string): Promise<void> => {
    setOpenFailed(null);
    try {
      await ipc.openExternalUrl(url);
    } catch {
      setOpenFailed(`${name} 打开失败，请手动访问 ${url}`);
    }
  };

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="px-5 pb-4 pt-6">
        <div className="mb-4 flex items-center gap-2">
          <BackButton />
          <h1 className="text-xl font-bold tracking-tight">意见反馈</h1>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {ISSUE_CHANNELS.map((ch) => {
            const Icon = ch.icon;
            return (
              <button
                key={ch.key}
                type="button"
                onClick={() => void openChannel(ch.url, ch.name)}
                className="group flex items-center gap-3 rounded-xl border border-border bg-card/60 p-4 text-left transition-colors hover:border-primary/40 hover:bg-card/80"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{ch.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{ch.host}</span>
                </span>
                <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              </button>
            );
          })}

          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            问题与建议请选择常用平台提交 Issue；提交前建议先搜一下已有的 Issue。
          </p>

          {openFailed && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {openFailed}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 【Legacy 旧反馈列表页 · 2026-11-14 停用】（用户裁定：入口只留双仓 Issue）
// 代码未删除，逐行注释保留；恢复时去掉本段行注释、把上面新组件改名或
// 换回本组件的导出名即可（/feedback/submit、/feedback/$id 路由未动）。
// ══════════════════════════════════════════════════════════════════════════
// import { useState } from "react";
// import { useNavigate } from "@tanstack/react-router";
// import { BackButton } from "@/components/layout/BackButton";
// import { usePagedList } from "@/hooks/usePagedList";
// import { ListLoadProgress } from "@/components/discovery/Skeletons";
// import * as ipc from "@/services/ipc";
// import {
//   FEEDBACK_PAGE_SIZE,
//   feedbackStatusClass,
//   feedbackStatusLabel,
//   feedbackTypeClass,
//   feedbackTypeLabel,
//   formatFeedbackTime,
//   normalizePage,
//   type FeedbackItem,
// } from "@/lib/feedback";

// /**
//  * 意见反馈首页（路由 /feedback）：我的反馈 / 公开反馈 两个 Tab 的查询列表。
//  *
//  * 与移动端 pages/feedback/index 同构：
//  * - 「我的」= 全部状态按提交时间倒序；「公开」= 已发布且公开的；
//  * - 点条目进详情（/feedback/$id），右上「写反馈」去提交页；
//  * - 提交/查询都要求登录，未登录时命令报错，这里如实显示。
//  *
//  * 表面语言与个人中心一致（壁纸页不做实底）：卡片 bg-card/60 半透明砖，
//  * 悬停加深 + 品牌色描边。
//  */
// const TABS = [
//   { key: "mine", label: "我的" },
//   { key: "public", label: "公开" },
// ] as const;

// type TabKey = (typeof TABS)[number]["key"];

// export function FeedbackListPage(): React.JSX.Element {
//   const navigate = useNavigate();
//   const [tab, setTab] = useState<TabKey>("mine");

//   const { items, loading, error, finished, reload } = usePagedList<FeedbackItem>({
//     resetKey: tab,
//     pageSize: FEEDBACK_PAGE_SIZE,
//     keyOf: (f) => String(f.id),
//     fetchPage: async (page) => {
//       const raw =
//         tab === "mine"
//           ? await ipc.astralMyFeedback(page, FEEDBACK_PAGE_SIZE)
//           : await ipc.astralPublicFeedback(page, FEEDBACK_PAGE_SIZE);
//       const { records, total } = normalizePage(raw);
//       return { list: records, hasMore: records.length < total };
//     },
//     // 一次拉全量（用户 m05614）：接口本来就回 total，翻到够数就停。
//     // 反馈量不大（几十条），20 页只是安全阀。
//     mode: "all",
//     maxPages: 20,
//   });

//   return (
//     <div className="h-full min-w-0 overflow-y-auto">
//       <div className="px-5 pb-4 pt-6">
//         <div className="mb-4 flex items-center gap-2">
//           <BackButton />
//           <h1 className="text-xl font-bold tracking-tight">意见反馈</h1>
//           <button
//             type="button"
//             onClick={() => void navigate({ to: "/feedback/submit" })}
//             className="ml-auto h-8 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
//           >
//             写反馈
//           </button>
//         </div>

//         <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
//           <div className="flex gap-1 self-start rounded-lg bg-card/60 p-1">
//             {TABS.map((t) => (
//               <button
//                 key={t.key}
//                 type="button"
//                 onClick={() => setTab(t.key)}
//                 className={`h-7 rounded-md px-4 text-xs transition-colors ${
//                   tab === t.key
//                     ? "bg-background font-medium text-foreground shadow-sm"
//                     : "text-muted-foreground hover:text-foreground"
//                 }`}
//               >
//                 {t.label}
//               </button>
//             ))}
//           </div>

//           {error ? (
//             <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
//               {error}
//               <button
//                 type="button"
//                 onClick={reload}
//                 className="ml-2 underline underline-offset-2"
//               >
//                 重试
//               </button>
//             </div>
//           ) : loading ? (
//             <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
//           ) : items.length === 0 ? (
//             <div className="py-16 text-center text-sm text-muted-foreground">
//               {tab === "mine" ? "还没有反馈，说说你的想法吧" : "暂无公开反馈"}
//             </div>
//           ) : (
//             <>
//               <ul className="flex flex-col gap-2.5">
//                 {items.map((f) => (
//                   <li key={f.id}>
//                     <button
//                       type="button"
//                       onClick={() =>
//                         void navigate({ to: "/feedback/$id", params: { id: String(f.id) } })
//                       }
//                       className="w-full rounded-xl border border-border bg-card/60 p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-card/80"
//                     >
//                       <div className="flex items-center gap-2">
//                         <span
//                           className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${feedbackTypeClass(f.type)}`}
//                         >
//                           {feedbackTypeLabel(f.type)}
//                         </span>
//                         <span className="min-w-0 flex-1 truncate text-sm font-medium">
//                           {f.title}
//                         </span>
//                         <span
//                           className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${feedbackStatusClass(f.status)}`}
//                         >
//                           {feedbackStatusLabel(f.status)}
//                         </span>
//                       </div>
//                       <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
//                         {f.content}
//                       </p>
//                       <div className="mt-1.5 flex items-center justify-between text-2xs text-muted-foreground">
//                         <span>{formatFeedbackTime(f.createTime)}</span>
//                         {tab === "mine" && f.isPublic && (
//                           <span className="text-emerald-500">已公开</span>
//                         )}
//                       </div>
//                     </button>
//                   </li>
//                 ))}
//               </ul>
//               <ListLoadProgress finished={finished} count={items.length} noun="反馈" unit="条" />
//             </>
//           )}
//         </div>
//       </div>
//     </div>
//   );
// }
