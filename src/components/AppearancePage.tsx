import { PageContainer } from "@/components/layout/PageContainer";
import { AppearanceSection } from "@/components/settings/sections/AppearanceSection";

/**
 * 外观独立页（DESIGN §5.3）。
 *
 * 为什么从设置里搬出来：换肤/亮暗/字体缩放是**高频且看一眼就想改**的操作，
 * 原先藏在「设置 → 外观」两跳之后，用户要先离开当前页面才够得着。现在标题栏
 * 右侧直接给一个「皮肤」入口（头像 → 通知 → 设置 → 皮肤），一步可达；
 * 设置页随之不再保留「外观」分节（见 components/SettingsPage.tsx）。
 *
 * 内容仍复用 settings/sections/AppearanceSection，不做第二套实现 —— 免得
 * 两处控件与默认值各自漂移（外观偏好是跨端契约，见 tests/appearance-contract）。
 */
export function AppearancePage(): React.JSX.Element {
  return (
    <PageContainer title="外观">
      <AppearanceSection />
    </PageContainer>
  );
}
