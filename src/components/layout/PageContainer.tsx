/** 页面容器：统一的标题 + 内容留白（DESIGN §12.2 PageContainer） */
export function PageContainer(props: {
  title: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <h1 className="shrink-0 px-6 pt-6 text-xl font-bold">{props.title}</h1>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">{props.children}</div>
    </div>
  );
}
