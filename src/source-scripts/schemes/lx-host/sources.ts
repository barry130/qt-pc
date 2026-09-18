/**
 * LX 脚本宿主实例目录 —— 每个可用脚本一份 createLxHost 实例（懒初始化、
 * 单飞；首次取链时启动脚本并等 handler 注册）。
 *
 * 2026-09-17 架构收敛后没有独立插件：宿主由脚本包聚合链
 * （actions/play-url.ts 的 SCRIPT_LINES）与 premium 剩余链直接调用；
 * 具体平台/音质参与面以《音源全量复测报告》探测矩阵为准。
 *
 * 注意：脚本原文经 ?raw 引入（SCRIPT_MD5/完整性自检依赖逐字节一致），
 * 执行体是 gen-lx-vendor.mjs 生成的 vendored/<id>.wrapped.js。
 * 更新脚本 = 覆盖 vendored/<id>.js 后重跑 node scripts/gen-lx-vendor.mjs。
 */
import type { MusicInfo, Quality, RequestBuiltin, Source } from "../../contract";
import type { PlayUrlResolver } from "../define";
import { createLxHost, type LxHost } from "./bridge";
import rawGdstudio from "./vendored/gdstudio.js?raw";
import { runLxScript as runGdstudio } from "./vendored/gdstudio.wrapped.js";
import rawKulou from "./vendored/kulou.js?raw";
import { runLxScript as runKulou } from "./vendored/kulou.wrapped.js";
import rawLuoxue from "./vendored/luoxue.js?raw";
import { runLxScript as runLuoxue } from "./vendored/luoxue.wrapped.js";
import rawLxv6 from "./vendored/lxv6.js?raw";
import { runLxScript as runLxv6 } from "./vendored/lxv6.wrapped.js";
import rawMolan from "./vendored/molan.js?raw";
import { runLxScript as runMolan } from "./vendored/molan.wrapped.js";
import rawQuandouyao from "./vendored/quandouyao.js?raw";
import { runLxScript as runQuandouyao } from "./vendored/quandouyao.wrapped.js";
import rawShouji from "./vendored/shouji.js?raw";
import { runLxScript as runShouji } from "./vendored/shouji.wrapped.js";
import rawStellarwave from "./vendored/stellarwave.js?raw";
import { runLxScript as runStellarwave } from "./vendored/stellarwave.wrapped.js";
import rawSuyin from "./vendored/suyin.js?raw";
import { runLxScript as runSuyin } from "./vendored/suyin.wrapped.js";
import rawYuningxi from "./vendored/yuningxi.js?raw";
import { runLxScript as runYuningxi } from "./vendored/yuningxi.wrapped.js";
import rawYuningxiPro from "./vendored/yuningxi-pro.js?raw";
import { runLxScript as runYuningxiPro } from "./vendored/yuningxi-pro.wrapped.js";
import rawYuxi from "./vendored/yuxi.js?raw";
import { runLxScript as runYuxi } from "./vendored/yuxi.wrapped.js";

/** 玉宁熙-Pro V1.2.2（wy/tx/kw/kg/mg，实测五平台最优之一） */
export const yuningxiProHost: LxHost = createLxHost({ rawScript: rawYuningxiPro, run: runYuningxiPro });
/** 屿溪-终章（wy/tx/kw/mg） */
export const yuxiHost: LxHost = createLxHost({ rawScript: rawYuxi, run: runYuxi });
/** stellarwave v3.2.0（tx VIP FLAC / kw，wy 免费） */
export const stellarwaveHost: LxHost = createLxHost({ rawScript: rawStellarwave, run: runStellarwave });
/** 墨澜 v2.3.0（wy/kw；与 stellarwave 同构，依赖 utils.crypto.aesEncrypt） */
export const molanHost: LxHost = createLxHost({ rawScript: rawMolan, run: runMolan });
/** 洛雪音乐源 1.0.0 v2-fix（tx 免费 / kw） */
export const luoxueHost: LxHost = createLxHost({ rawScript: rawLuoxue, run: runLuoxue });
/**
 * 玉宁熙 v1.1.5（tx/kw；老版。2026-09-17 探测全挂，未参与聚合链，上游恢复后
 * 可在 SCRIPT_LINES/PREMIUM_LINES 中加回）
 */
export const yuningxiHost: LxHost = createLxHost({ rawScript: rawYuningxi, run: runYuningxi });
/**
 * 溯音 v1（wy/kw-320）。其 kw 线路（oiapi.net/api/Kuwo 按歌名搜索）与全豆要
 * 内嵌的「溯音搜索」逐参数同款（二次封装），已被全豆要覆盖，未参与聚合链；
 * 上游若新增差异化线路可加回。
 */
export const suyinHost: LxHost = createLxHost({ rawScript: rawSuyin, run: runSuyin });
/** 收集の聚合接口（wy/tx。2026-09-17 探测全挂，未参与聚合链，上游恢复后可加回） */
export const shoujiHost: LxHost = createLxHost({ rawScript: rawShouji, run: runShouji });
/** gdstudio v1.0.1（仅 wy；与脚本包 wyy 官方核心首线同源，wy 专用宿主暂不参与聚合链） */
export const gdstudioHost: LxHost = createLxHost({ rawScript: rawGdstudio, run: runGdstudio });
/**
 * 裤佬 SVIP（kw 免请求直出链 musicapi.haitangw.net/music/kw.php）。该最终
 * URL 与全豆要链内「长青 SVIP」模板完全相同（二次封装），已被全豆要覆盖，
 * 未参与聚合链；上游恢复 wy 等差异化线路后可加回。
 */
export const kulouHost: LxHost = createLxHost({ rawScript: rawKulou, run: runKulou });
/**
 * 全豆要 v4.1（kw）：聚合源，kw 链 = 星海主 → Huibq → 溯音搜索（= 溯音的
 * oiapi 线路）→ 聆川 → 长青 SVIP（= 裤佬的 haitangw 直出链）→ 念心 SVIP，
 * 是裤佬/溯音的超集，去重后作为这两家的 kw 唯一代表进入脚本包 kw 链。
 */
export const quandouyaoHost: LxHost = createLxHost({ rawScript: rawQuandouyao, run: runQuandouyao });
/** 独家音源 v6（kw/kg；脚本包 kg 链 + premium kw 链共用同一实现） */
export const lxv6Host: LxHost = createLxHost({ rawScript: rawLxv6, run: runLxv6 });

// ---------- scriptId → 宿主 懒注册表（chain.json kind:"lx" 线路引用） ----------

/** 单飞包装：同一 scriptId 永远复用同一宿主实例 */
function singleton(factory: () => LxHost): () => LxHost {
  let host: LxHost | null = null;
  return () => {
    if (host === null) host = factory();
    return host;
  };
}

/**
 * scriptId → 宿主工厂 的懒注册表（音源包热更新方案 P0：宿主不再按导入顺序
 * 隐式耦合，chain.json 的 lx 线路用 scriptId 引用；P1 引擎窗口重建时按此
 * 表重新实例化）。宿主实例本身懒创建（首次取链才启动脚本）。
 */
export const LX_HOST_REGISTRY: Record<string, () => LxHost> = {
  "yuningxi-pro": singleton(() => yuningxiProHost),
  yuxi: singleton(() => yuxiHost),
  stellarwave: singleton(() => stellarwaveHost),
  molan: singleton(() => molanHost),
  luoxue: singleton(() => luoxueHost),
  yuningxi: singleton(() => yuningxiHost),
  suyin: singleton(() => suyinHost),
  shouji: singleton(() => shoujiHost),
  gdstudio: singleton(() => gdstudioHost),
  kulou: singleton(() => kulouHost),
  quandouyao: singleton(() => quandouyaoHost),
  lxv6: singleton(() => lxv6Host),
};

/** chain.json lx 线路取宿主；scriptId 不存在返回 null（线路跳过） */
export function getLxHost(scriptId: string): LxHost | null {
  const factory = LX_HOST_REGISTRY[scriptId];
  return factory !== undefined ? factory() : null;
}

/** 契约平台 → LX 源 id（契约 wyy/qq ↔ LX 口径 wy/tx；kw/kg 同名） */
const CONTRACT_TO_LX: Record<Source, string> = { wyy: "wy", qq: "tx", kw: "kw", kg: "kg" };

/** 取链快捷函数：把契约平台/音质翻译成 LX 口径后调宿主 */
export function lxPlayUrl(
  host: LxHost,
  request: RequestBuiltin,
  platform: Source,
  song: MusicInfo,
  quality: Quality,
): Promise<string> {
  return host.getUrl(request, CONTRACT_TO_LX[platform], song, quality);
}

/** 给指定宿主生成一组平台的 playUrl 解析器（插件 scheme 用；空 URL 按失败抛错） */
export function lxPlayUrlSet(
  host: LxHost,
  scriptName: string,
  platforms: Source[],
): Partial<Record<Source, PlayUrlResolver>> {
  return Object.fromEntries(
    platforms.map((platform): [Source, PlayUrlResolver] => [
      platform,
      async (request, song, quality) => {
        const url = await lxPlayUrl(host, request, platform, song, quality);
        if (!url) throw new Error(`${scriptName} ${platform} 线路未取到播放地址`);
        return url;
      },
    ]),
  );
}
