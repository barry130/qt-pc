/**
 * 共享 UI 原语层的唯一入口。
 *
 * 规则（详见 `docs/UI-COMPONENTS.md`）：
 * 1. **先查这里**：写页面前先看本文件导出的组件能不能直接用，别在页面里重画一遍；
 * 2. **新组件进这里**：确实缺一种交互时，新建 `src/components/ui/xxx.tsx` 并在此导出，
 *    然后在文档里登记，而不是塞进某个页面文件里当「局部组件」；
 * 3. **页面只做业务**：页面里出现的 `<button className=...>`、`<input className=...>`、
 *    `fixed inset-0 bg-black/40` 这类基础外观，都属于应该被本层吸收的重复。
 *
 * 历史路径的兼容：`@/components/common/EmptyState`、`@/components/settings/controls`
 * 等旧入口仍然可用（内部转调本层），但**新代码请统一从 `@/components/ui` 导入**。
 */
export { Button, buttonVariants, buttonClass, type ButtonProps } from "./button";
export { Badge, badgeVariants, type BadgeProps } from "./badge";
export { LoadingState, Spinner, type SpinnerSize } from "./spinner";
export { Input, Textarea, Select, Checkbox, Field, type ControlSize } from "./form";
export { FormRow } from "./form-row";
export { Switch } from "./switch";
export { Segmented } from "./segmented";
export { Modal, ConfirmDialog, type ModalSize } from "./modal";
export {
  DetailHero,
  HeroBackdrop,
  HeroCover,
  HeroEyebrow,
  HeroMeta,
  HeroPlayButton,
  HeroTitle,
} from "./hero";
export { SectionHeader, Card } from "./section";
export { Skeleton, RowsSkeleton, GridSkeleton } from "./skeleton";

/** 既有共享组件（尚未迁到 ui/ 目录，但语义同属本层） */
export { EmptyState } from "@/components/common/EmptyState";
export { IconButton } from "@/components/common/IconButton";
export { Popover } from "@/components/common/Popover";
export { RowActions, BatchDeleteButton } from "@/components/common/RowActions";
export { SourceTag } from "@/components/common/SourceTag";
export { ArtistAvatar } from "@/components/common/ArtistAvatar";
export { ErrorRetry, LoadBar, ListLoadProgress } from "@/components/discovery/Skeletons";
export { TrackRowsSkeleton } from "@/components/discovery/Skeletons";
export { CoverGridSkeleton } from "@/components/discovery/Skeletons";
