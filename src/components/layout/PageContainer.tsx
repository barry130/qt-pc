/** 页面容器：统一的标题 + 内容留白（DESIGN §12.2 PageContainer） */
export function PageContainer(props: {
  title: string;
  /** 固定在标题下、滚动区外的头部行（如设置页的分节标签），不随内容滚动 */
  stickyHeader?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <h1 className="shrink-0 px-6 pt-6 text-xl font-bold">{props.title}</h1>
      {props.stickyHeader != null && (
        <div className="shrink-0 px-6">{props.stickyHeader}</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">{props.children}</div>
    </div>
  );
}
