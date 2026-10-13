import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASE_SCOPES,
  ICON_REPO_PATH,
  ICON_URL,
  REPO_URL,
  adminRequest,
  eventsFor,
  renderManifest,
  scopesFor,
} from "../../src/slack/manifest.js";

describe("manifest", () => {
  it("is valid JSON so the paste cannot fail on quoting", () => {
    const parsed = JSON.parse(renderManifest({ appName: "Herdr" }));
    expect(parsed.display_information.name).toBe("Herdr");
  });

  it("enables Socket Mode and interactivity", () => {
    const parsed = JSON.parse(renderManifest({ appName: "Herdr" }));
    expect(parsed.settings.socket_mode_enabled).toBe(true);
    expect(parsed.settings.interactivity.is_enabled).toBe(true);
  });

  it("declares no slash commands — the app is driven from the UI", () => {
    const parsed = JSON.parse(renderManifest({ appName: "Herdr" }));
    expect(parsed.features.slash_commands).toBeUndefined();
    expect(parsed.features.shortcuts).toBeUndefined();
  });

  it("enables the Home tab, which is the main surface", () => {
    const parsed = JSON.parse(renderManifest({ appName: "Herdr" }));
    expect(parsed.features.app_home.home_tab_enabled).toBe(true);
  });

  it("requests channel and group history scopes for context", () => {
    const scopes = scopesFor({ appName: "Herdr" });
    expect(scopes).toEqual([...BASE_SCOPES]);
    expect(scopes).toContain("channels:history");
    expect(scopes).toContain("groups:history");
    expect(scopes).not.toContain("commands");
  });

  it("asks for users:read only to show context usernames, never emails", () => {
    const scopes = scopesFor({ appName: "Herdr" });
    expect(scopes).toContain("users:read");
    expect(scopes).not.toContain("users:read.email");
    expect(adminRequest({ appName: "Herdr" })).toContain(
      "users:read: show usernames instead of member IDs in context; not used for access",
    );
  });

  it("always includes the scopes each surface actually needs", () => {
    const scopes = scopesFor({ appName: "Herdr" });
    for (const required of ["chat:write", "im:history", "assistant:write"]) {
      expect(scopes).toContain(required);
    }
  });

  it("subscribes to the events every surface depends on", () => {
    // app_context_changed belongs to the agent messaging experience: Slack
    // sends it when the user switches which thread the agent pane is showing.
    expect(eventsFor({ appName: "Herdr" })).toEqual([
      "app_home_opened",
      "app_context_changed",
      "message.im",
      "app_mention",
      "message.channels",
      "message.groups",
    ]);
  });

  it("declares the agent container, which is what makes a big herd navigable", () => {
    const manifest = JSON.parse(renderManifest({ appName: "Herdr" }));
    expect(manifest.features.agent_view.agent_description).toBeTruthy();
    expect(manifest.features.agent_view.agent_description.length).toBeLessThanOrEqual(300);
    for (const prompt of manifest.features.agent_view.suggested_prompts) {
      expect(Object.keys(prompt).sort()).toEqual(["message", "title"]);
    }
  });

  it("asks for assistant:write, without which threads cannot be titled", () => {
    // setTitle answers missing_scope otherwise, and the timeline shows every
    // agent as an identical untitled row.
    expect(scopesFor({ appName: "Herdr" })).toContain("assistant:write");
  });

  describe("admin request", () => {
    it("leads with the objection admins actually have", () => {
      const text = adminRequest({ appName: "Herdr (work)" });
      expect(text).toContain("Socket Mode");
      expect(text).toContain("no public URL");
      expect(text).toContain("no inbound firewall");
    });

    it("justifies every scope it asks for", () => {
      const text = adminRequest({ appName: "Herdr" });
      for (const scope of BASE_SCOPES) {
        expect(text).toContain(scope);
      }
    });

    it("links the source and the security policy so an admin can review it", () => {
      // An admin has no basis to approve terminal access they cannot read.
      const text = adminRequest({ appName: "Herdr" });
      expect(text).toContain(REPO_URL);
      expect(text).toContain("SECURITY.md");
    });
  });
});

describe("app icon", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

  it("actually exists at the path the URL promises", () => {
    // The URL is a hardcoded string pointing into this repo; if the file moves
    // and only the constant is updated (or vice versa), nothing else catches
    // it — the link just 404s for whoever follows it.
    expect(existsSync(path.join(repoRoot, ICON_REPO_PATH))).toBe(true);
  });

  it("builds the raw URL from the same path", () => {
    expect(ICON_URL).toBe(`${REPO_URL}/raw/main/${ICON_REPO_PATH}`);
  });
});
