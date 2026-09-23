import { useEffect } from "react";
import { useAppearanceStore } from "@/stores/appearance";
import { getSkin, hexToRgb, isLightColor } from "@/lib/skins";

/**
 * 外观偏好应用（DESIGN §9.2 / R7）：
 * - mode → html 上的 .dark 类；system 模式挂 matchMedia 监听实时跟随
 * - skinId → 根据皮肤定义设置 --primary / --ring / --background / --sidebar / --sidebar-primary
 * - customColor → skinId="custom" 时覆盖主色
 * - followCoverColor → --primary 优先使用 --cover-primary（由 useCoverColor 设置）
 * - bgImage → 设置 --bg-image CSS 变量，并把标题栏/侧栏底色派生为半透明的 --sidebar-surface
 * - fontScale → html font-size（rem 基准，0.85–1.25）
 * - reduceMotion → html 上的 .reduce-motion 类
 */

/**
 * 有背景图时标题栏 / 侧边栏底色的不透明度（%）。
 * 壁纸层本身是 opacity-40，再叠这一层后壁纸的实际可见度约为 (100-该值)% × 40%。
 * 35 时约 26%：壁纸能看清，同时给侧栏那几行导航文字留了压底。
 */
const SIDEBAR_BG_ALPHA = 35;
export function useAppearanceEffect(): void {
  const preference = useAppearanceStore((s) => s.preference);
  const load = useAppearanceStore((s) => s.load);
  const loaded = useAppearanceStore((s) => s.loaded);
  const {
    mode,
    fontScale,
    reduceMotion,
    skinId,
    followCoverColor,
    customColor,
    bgImage,
  } = preference;

  // 启动时从 SQLite 读一次
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // 亮暗模式 + 皮肤配色
  useEffect(() => {
    const root = document.documentElement;
    const skin = getSkin(skinId, customColor);

    const apply = (): void => {
      const isDark =
        mode === "dark" ||
        (mode === "system" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", isDark);

      const skinPrimary = isDark ? skin.primaryDark : skin.primaryLight;
      const skinBg = isDark ? skin.bgDark : skin.bgLight;
      const skinSidebar = isDark ? skin.sidebarDark : skin.sidebarLight;
      const primary = followCoverColor
        ? `var(--cover-primary, ${skinPrimary})`
        : skinPrimary;
      root.style.setProperty("--primary", primary);
      root.style.setProperty("--ring", primary);
      root.style.setProperty("--background", skinBg);
      // --sidebar-base 始终是皮肤底色（不含封面色），作为 --sidebar 混合的基准。
      // 跟随封面时让侧栏底色也被封面色轻染：基准色是 CSS 变量而非 JS 计算值，
      // 所以深浅模式切换或换肤后 mix 会自动重算，不用等下一次切歌。
      // 注意：--sidebar 在此可能是 color-mix() 表达式，消费方不要再叠透明度修饰符
      // （Tailwind 的 bg-sidebar/60 会再包一层 color-mix）；需要半透明用 --sidebar-surface。
      root.style.setProperty("--sidebar-base", skinSidebar);
      const sidebarColor = followCoverColor
        ? `color-mix(in srgb, var(--cover-primary, var(--sidebar-base)) 22%, var(--sidebar-base))`
        : skinSidebar;
      root.style.setProperty("--sidebar", sidebarColor);
      // 标题栏 / 侧边栏的底色（消费方统一用 bg-[color:var(--sidebar-surface)]）。
      // 设了背景图时必须半透明：这两块原先是不透明底色，会把最底层那张壁纸整块挡住，
      // 于是壁纸只铺在内容区。无背景图时与 --sidebar 完全相同，外观零变化。
      root.style.setProperty(
        "--sidebar-surface",
        bgImage
          ? `color-mix(in srgb, ${sidebarColor} ${SIDEBAR_BG_ALPHA}%, transparent)`
          : sidebarColor,
      );
      root.style.setProperty("--sidebar-primary", primary);
      root.style.setProperty("--sidebar-primary-foreground", "#ffffff");

      // 封面取色模式下由 useCoverColor 管理前景色，此处不覆盖。
      // 皮肤主色同样要按明度翻转前景色：森林 #4ade80 / 暖阳 #fb923c / 深海 #38bdf8 /
      // 樱花 #f472b6 这些亮主色配白字只有 1.7~2.3:1，主色实心按钮上的图标文字会糊掉，
      // 也让「已开启」态失去对比。解析不出十六进制（非常规自定义色）时回退白字。
      if (!followCoverColor) {
        const rgb = hexToRgb(skinPrimary);
        root.style.setProperty(
          "--primary-foreground",
          rgb && isLightColor(rgb[0], rgb[1], rgb[2]) ? "#1a1a1a" : "#ffffff",
        );
      }
    };

    if (mode !== "system") {
      apply();
      return;
    }

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mode, skinId, followCoverColor, customColor, bgImage]);

  // 背景图片
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--bg-image",
      bgImage || "",
    );
  }, [bgImage]);

  // 字体缩放：rAF 合并写入 + font-size 平滑过渡，避免拖动滑块时逐帧回流抖动
  useEffect(() => {
    const root = document.documentElement;
    const scale = Math.min(1.25, Math.max(0.85, fontScale || 1));
    root.style.transition = reduceMotion ? "" : "font-size 120ms ease-out";
    const raf = requestAnimationFrame(() => {
      root.style.fontSize = `${16 * scale}px`;
    });
    return () => {
      cancelAnimationFrame(raf);
      root.style.fontSize = "";
      root.style.transition = "";
    };
  }, [fontScale, reduceMotion]);

  // 减弱动效
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  // 皮肤系统 data 属性
  useEffect(() => {
    document.documentElement.dataset.skin = skinId;
    document.documentElement.dataset.followCover = followCoverColor ? "1" : "0";
  }, [skinId, followCoverColor]);
}
