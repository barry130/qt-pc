// 「仅首次登录弹出」按公告 id 记已弹：核心诉求是「看过旧公告，新公告还能弹」。
// 同时老版本全局标记（=已弹过任意一条）必须在升级后一次性迁移，不能把新公告一起压掉。
import { describe, expect, it } from "vitest";
import {
  LEGACY_FIRST_LOGIN_KEY,
  markFirstLoginShown,
  migrateLegacyFirstLogin,
  readFirstLoginShown,
} from "@/lib/noticeFirstLogin";

function memoryStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("notice first-login marks", () => {
  it("按公告 id 独立记录：标记 A 不影响 B", () => {
    const store = memoryStore();
    expect(readFirstLoginShown(1, store)).toBe(false);
    markFirstLoginShown(1, store);
    expect(readFirstLoginShown(1, store)).toBe(true);
    expect(readFirstLoginShown(2, store)).toBe(false);
  });

  it("存储异常时读按未弹处理、写静默失败", () => {
    const broken = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("quota");
      },
    };
    expect(readFirstLoginShown(1, broken)).toBe(false);
    expect(() => markFirstLoginShown(1, broken)).not.toThrow();
  });

  it("老全局标记迁移成按条标记，并删除老键", () => {
    const store = memoryStore({ [LEGACY_FIRST_LOGIN_KEY]: "shown" });
    expect(migrateLegacyFirstLogin([1, 2], store)).toBe(true);
    expect(readFirstLoginShown(1, store)).toBe(true);
    expect(readFirstLoginShown(2, store)).toBe(true);
    expect(store.data.has(LEGACY_FIRST_LOGIN_KEY)).toBe(false);
  });

  it("迁移后新公告（不在旧列表里）仍然会弹", () => {
    const store = memoryStore({ [LEGACY_FIRST_LOGIN_KEY]: "shown" });
    migrateLegacyFirstLogin([1], store);
    expect(readFirstLoginShown(3, store)).toBe(false);
  });

  it("没有老标记时不迁移", () => {
    const store = memoryStore();
    expect(migrateLegacyFirstLogin([1], store)).toBe(false);
    expect(readFirstLoginShown(1, store)).toBe(false);
  });
});
