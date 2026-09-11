import { PageContainer } from "@/components/layout/PageContainer";

/** M1 占位页：路由与导航先通，feature 内容在后续里程碑逐个落地 */
export function PlaceholderPage(props: {
  title: string;
  description?: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <PageContainer title={props.title}>
      <div className="flex h-full min-h-40 items-center justify-center">
        <div className="text-center text-sm text-muted-foreground">
          <p>该功能将在后续里程碑交付</p>
          {props.description && <p className="mt-1">{props.description}</p>}
          {props.hint && (
            <p className="mt-1 font-mono text-xs">路由参数：{props.hint}</p>
          )}
        </div>
      </div>
    </PageContainer>
  );
}
