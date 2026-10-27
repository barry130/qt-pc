import { SettingRow } from "../controls";
import { useNavigate } from "@tanstack/react-router";

export function SourceAccountSection(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <SettingRow
      title="音源账号"
      description="扫码登录音源官方账号（凭据只存本机）；每个音源单独管理数据/播放请求是否使用登录态。"
    >
      <button
        type="button"
        onClick={() => void navigate({ to: "/source-accounts" })}
        className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
      >
        前往管理
      </button>
    </SettingRow>
  );
}

/** 音源包设置（v3 统一包模型，与 uniappx 设置面板同口径）：
 *  - 数据包/播放包同构：单文件 js、首行 __QT_PACK__ 包头自描述身份；
 *  - 数据槽 = 用户安装的数据包（不内置；未装 = 数据面下线，首页引导指路）；
 *  - 播放槽 = 用户安装的播放包（不随应用分发，多包共存其一生效）；
 *  - 更新发现双通道合一（每包 updateUrl / 官方 manifest），仅对已装包，
 *    只提示不自动装，这里可以逐条应用；
 *  - 安装入口：https 直链 / 本地文件（系统选择框），先预览确认再落盘
 *    （包头 id 自称官方包时显著警示），剪贴板有包链接时主动询问；
 *    卸载两击确认。
 *  状态事实来源是 Rust state.json（v3）；安装/切换/卸载后 Rust 广播
 *  source-pack-changed / source-meta-changed，引擎页热切换生效——
 *  不重启应用、不打断播放。 */
