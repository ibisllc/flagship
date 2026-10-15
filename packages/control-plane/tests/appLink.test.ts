import { describe, expect, it } from "vitest";
import { appRouteLink } from "../src/appLink.js";

describe("appRouteLink", () => {
  it("builds an https /app/ link on the control apex", () => {
    expect(appRouteLink("settings/two-factor")).toBe("https://flagshipserver.com/app/settings/two-factor");
    expect(appRouteLink("account/security", { u: "plucky avocet" })).toBe(
      "https://flagshipserver.com/app/account/security?u=plucky+avocet",
    );
    expect(appRouteLink("install-progress", {}, "gym.flagshipserver.com")).toBe(
      "https://gym.flagshipserver.com/app/install-progress",
    );
  });
});
