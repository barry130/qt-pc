/**
 * 官网根地址（自有地址，值只在 Rust 侧）。
 *
 * 未配置时返回空串：公开仓库形态 / 私有配置缺失时，设置页的官网入口整体不渲染，
 * 而不是给出一个打不开的链接。取值失败（命令不存在、引擎窗口）同样按未配置处理。
 */
import { useEffect, useState } from "react";
import { getOfficialSiteUrl } from "@/lib/official-site";

export function useOfficialSiteUrl(): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true;
    void getOfficialSiteUrl().then((v) => {
      if (alive) setUrl(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return url;
}
