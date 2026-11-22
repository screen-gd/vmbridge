import { afterEach, expect, test } from "bun:test";
import { copyText } from "./clipboard.ts";

// Just enough of the browser for copyText: what each path copied ends up in `copied`.
function browser({ secure, writeText, execCommand }: { secure: boolean; writeText?: (text: string) => Promise<void>; execCommand: boolean }) {
  const copied: string[] = [];
  let selected = "";
  const textarea = {
    value: "",
    readOnly: false,
    style: {},
    select() {},
    setSelectionRange(start: number, end: number) {
      selected = this.value.slice(start, end);
    },
    remove() {},
  };
  Object.assign(globalThis, {
    window: { isSecureContext: secure },
    navigator: writeText ? { clipboard: { writeText } } : {},
    HTMLElement: class {},
    document: {
      activeElement: null,
      getSelection: () => null,
      createElement: () => textarea,
      execCommand: () => {
        if (execCommand) copied.push(selected);
        return execCommand;
      },
    },
  });
  return { copied, near: { after() {} } as unknown as HTMLElement };
}

const original = { window: globalThis.window, navigator: globalThis.navigator, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
afterEach(() => Object.assign(globalThis, original));

test("uses the clipboard API in a secure context", async () => {
  const written: string[] = [];
  const { copied, near } = browser({ secure: true, writeText: async (text) => void written.push(text), execCommand: true });
  expect(await copyText("http://host/pair#token", near)).toBe(true);
  expect(written).toEqual(["http://host/pair#token"]);
  expect(copied).toEqual([]);
});

test("falls back to selecting the text over plain HTTP", async () => {
  const { copied, near } = browser({ secure: false, execCommand: true });
  expect(await copyText("http://host/pair#token", near)).toBe(true);
  expect(copied).toEqual(["http://host/pair#token"]);
});

test("reports failure when neither way copies", async () => {
  const { near } = browser({ secure: true, writeText: () => Promise.reject(new Error("denied")), execCommand: false });
  expect(await copyText("x", near)).toBe(false);
});
