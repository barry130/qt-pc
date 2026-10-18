import { useState } from "react";
import { ArrowUpRight, Music2 } from "lucide-react";
import { qtresCoverUrl } from "@/lib/lrc";

function MixCover({ url }: { url: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const cover = qtresCoverUrl(url);
  return (
    <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted shadow-sm">
      {cover && !failed ? (
        <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : <Music2 className="h-7 w-7 text-muted-foreground/50" />}
    </div>
  );
}

/** 纯展示卡片；取数与路由由首页区块管理。 */
export function LocalMixCard(props: {
  title: string;
  subtitle: string;
  coverUrls: string[];
  onOpen: () => void;
}): React.JSX.Element {
  const covers = props.coverUrls.filter(Boolean).slice(0, 3);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="group min-w-0 rounded-xl border border-border bg-card/60 p-4 text-left transition-colors hover:border-primary/50 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-4 grid grid-cols-3 gap-2" aria-hidden="true">
        {[0, 1, 2].map((i) => <MixCover key={`${i}:${covers[i] ?? ""}`} url={covers[i] ?? ""} />)}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold">{props.title}</span>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground" title={props.subtitle}>{props.subtitle}</p>
    </button>
  );
}
