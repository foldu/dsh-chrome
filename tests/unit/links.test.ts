import { describe, expect, it } from "vitest";
import { navigatesInView } from "../../src/links";

describe("navigatesInView", () => {
  it("lets the harness view serve its own pages and assets", () => {
    expect(navigatesInView("http://127.0.0.1:3090/?token=abc")).toBe(true);
    expect(navigatesInView("https://dsh.home.5kw.li/")).toBe(true);
    expect(navigatesInView("file:///home/barnabas/src/x/dist/renderer/starting.html")).toBe(true);
    expect(navigatesInView("blob:http://127.0.0.1:3090/1234")).toBe(true);
    expect(navigatesInView("data:text/html,hello")).toBe(true);
    expect(navigatesInView("about:blank")).toBe(true);
  });

  it("hands a desktop's own schemes to the desktop", () => {
    // The one that matters: a remote project in the local Zed.
    expect(navigatesInView("zed://ssh/jupiter.home.5kw.li/home/barnabas/src/foo")).toBe(false);
    expect(navigatesInView("mailto:barnabas@example.com")).toBe(false);
    expect(navigatesInView("dsh-app://app/api/file?path=/x")).toBe(false);
  });

  it("leaves something that is not a URL to Chromium", () => {
    expect(navigatesInView("not a url")).toBe(true);
    expect(navigatesInView("")).toBe(true);
  });
});
