// jsdom 用例的确定性收尾。
//
// React 19 开发版的调度任务在宏任务里直接读 window（react-dom-client.development.js
// 的 performWorkOnRootViaSchedulerTask 首行 `schedulerEvent = window.event`）。
// 若用例结束时组件还挂着、更新仍排在真实调度器上，测试线程会先结束并拆除 jsdom
// 环境，随后执行的任务就抛 `ReferenceError: window is not defined`。vitest 把它记为
// unhandled error，于是即使全部用例 passed，进程仍以退出码 1 结束（CI 变红）。
//
// vitest 默认 globals=false，@testing-library/react 的自动 cleanup 依赖全局 afterEach，
// 因此不会生效；这里显式注册，让每个用例结束时都卸载自己的 React 树并排空队列。
import { afterEach } from "vitest";

afterEach(async () => {
  // node 环境的用例没有 document，跳过（也避免在无 DOM 环境下加载 @testing-library/react）
  if (typeof document === "undefined") return;

  const { cleanup } = await import("@testing-library/react");
  cleanup();

  // 排空两轮宏任务，让 cleanup 触发的更新在环境拆除前跑完
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
