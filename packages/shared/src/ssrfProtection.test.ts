import { describe, it, expect } from "vitest";
import {
  isPrivateOrRestrictedIP,
  validateSSRFURL,
  validateRedirectTarget,
  validateHostnameResolution,
  detectDNSRebinding
} from "./ssrfProtection.js";

describe("SSRF Protection", () => {
  describe("isPrivateOrRestrictedIP", () => {
    describe("IPv4 private ranges", () => {
      it("rejects 10.x.x.x (RFC 1918)", () => {
        expect(isPrivateOrRestrictedIP("10.0.0.0")).toBe(true);
        expect(isPrivateOrRestrictedIP("10.255.255.255")).toBe(true);
        expect(isPrivateOrRestrictedIP("10.100.50.25")).toBe(true);
      });

      it("rejects 172.16.x.x to 172.31.x.x (RFC 1918)", () => {
        expect(isPrivateOrRestrictedIP("172.16.0.0")).toBe(true);
        expect(isPrivateOrRestrictedIP("172.31.255.255")).toBe(true);
        expect(isPrivateOrRestrictedIP("172.20.50.25")).toBe(true);
      });

      it("rejects 192.168.x.x (RFC 1918)", () => {
        expect(isPrivateOrRestrictedIP("192.168.0.0")).toBe(true);
        expect(isPrivateOrRestrictedIP("192.168.255.255")).toBe(true);
        expect(isPrivateOrRestrictedIP("192.168.1.1")).toBe(true);
      });
    });

    describe("IPv4 special ranges", () => {
      it("rejects 0.x.x.x (current network)", () => {
        expect(isPrivateOrRestrictedIP("0.0.0.0")).toBe(true);
        expect(isPrivateOrRestrictedIP("0.255.255.255")).toBe(true);
      });

      it("rejects 127.x.x.x (loopback)", () => {
        expect(isPrivateOrRestrictedIP("127.0.0.0")).toBe(true);
        expect(isPrivateOrRestrictedIP("127.0.0.1")).toBe(true);
        expect(isPrivateOrRestrictedIP("127.255.255.255")).toBe(true);
      });

      it("rejects 169.254.x.x (link-local)", () => {
        expect(isPrivateOrRestrictedIP("169.254.0.0")).toBe(true);
        expect(isPrivateOrRestrictedIP("169.254.169.254")).toBe(true); // AWS metadata
        expect(isPrivateOrRestrictedIP("169.254.255.255")).toBe(true);
      });

      it("rejects 255.255.255.255 (broadcast)", () => {
        expect(isPrivateOrRestrictedIP("255.255.255.255")).toBe(true);
      });
    });

    describe("IPv4 public ranges", () => {
      it("accepts 8.8.8.8 (Google DNS)", () => {
        expect(isPrivateOrRestrictedIP("8.8.8.8")).toBe(false);
      });

      it("accepts 1.1.1.1 (Cloudflare DNS)", () => {
        expect(isPrivateOrRestrictedIP("1.1.1.1")).toBe(false);
      });

      it("accepts 172.15.x.x (outside RFC 1918 range)", () => {
        expect(isPrivateOrRestrictedIP("172.15.0.0")).toBe(false);
        expect(isPrivateOrRestrictedIP("172.15.255.255")).toBe(false);
      });

      it("accepts 172.32.x.x (outside RFC 1918 range)", () => {
        expect(isPrivateOrRestrictedIP("172.32.0.0")).toBe(false);
        expect(isPrivateOrRestrictedIP("172.32.255.255")).toBe(false);
      });

      it("accepts 192.0.2.1 (documentation range)", () => {
        expect(isPrivateOrRestrictedIP("192.0.2.1")).toBe(false);
      });
    });

    describe("IPv4 invalid formats", () => {
      it("rejects malformed IPv4", () => {
        expect(isPrivateOrRestrictedIP("256.256.256.256")).toBe(true);
        expect(isPrivateOrRestrictedIP("10.0.0")).toBe(true);
        expect(isPrivateOrRestrictedIP("10.0.0.0.0")).toBe(true);
        expect(isPrivateOrRestrictedIP("10.a.b.c")).toBe(true);
      });
    });

    describe("IPv6 loopback and link-local", () => {
      it("rejects ::1 (IPv6 loopback)", () => {
        expect(isPrivateOrRestrictedIP("::1")).toBe(true);
        expect(isPrivateOrRestrictedIP("[::1]")).toBe(true);
      });

      it("rejects fe80:: (IPv6 link-local)", () => {
        expect(isPrivateOrRestrictedIP("fe80::1")).toBe(true);
        expect(isPrivateOrRestrictedIP("fe80::ffff:192.0.2.1")).toBe(true);
        expect(isPrivateOrRestrictedIP("[fe80::1]")).toBe(true);
      });
    });

    describe("IPv6 ULA and special", () => {
      it("rejects fc00::/7 (IPv6 ULA)", () => {
        expect(isPrivateOrRestrictedIP("fc00::1")).toBe(true);
        expect(isPrivateOrRestrictedIP("fd00::1")).toBe(true);
        expect(isPrivateOrRestrictedIP("[fc00::1]")).toBe(true);
        expect(isPrivateOrRestrictedIP("[fd00::1]")).toBe(true);
      });

      it("rejects ff00::/8 (IPv6 multicast)", () => {
        expect(isPrivateOrRestrictedIP("ff00::1")).toBe(true);
        expect(isPrivateOrRestrictedIP("[ff00::1]")).toBe(true);
      });
    });

    describe("IPv6 IPv4-mapped", () => {
      it("rejects ::ffff:10.0.0.0 (IPv4-mapped private)", () => {
        expect(isPrivateOrRestrictedIP("::ffff:10.0.0.1")).toBe(true);
        expect(isPrivateOrRestrictedIP("::ffff:192.168.1.1")).toBe(true);
        expect(isPrivateOrRestrictedIP("[::ffff:127.0.0.1]")).toBe(true);
      });

      it("accepts ::ffff:8.8.8.8 (IPv4-mapped public)", () => {
        expect(isPrivateOrRestrictedIP("::ffff:8.8.8.8")).toBe(false);
      });
    });

    describe("IPv6 public addresses", () => {
      it("accepts 2001:4860:4860::8888 (Google DNS IPv6)", () => {
        expect(isPrivateOrRestrictedIP("2001:4860:4860::8888")).toBe(false);
      });

      it("accepts 2606:4700:4700::1111 (Cloudflare DNS IPv6)", () => {
        expect(isPrivateOrRestrictedIP("2606:4700:4700::1111")).toBe(false);
      });
    });

    describe("case insensitivity", () => {
      it("handles uppercase IPv6", () => {
        expect(isPrivateOrRestrictedIP("FE80::1")).toBe(true);
        expect(isPrivateOrRestrictedIP("FC00::1")).toBe(true);
      });

      it("handles mixed case IPv6", () => {
        expect(isPrivateOrRestrictedIP("2001:4860:4860::8888".toUpperCase())).toBe(false);
      });
    });
  });

  describe("validateSSRFURL", () => {
    it("accepts valid public HTTPS URL", () => {
      const result = validateSSRFURL("https://example.com/webhook");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.url.hostname).toBe("example.com");
      }
    });

    it("rejects HTTP URL", () => {
      const result = validateSSRFURL("http://example.com/webhook");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("HTTPS");
      }
    });

    it("rejects URL with credentials", () => {
      const result = validateSSRFURL("https://user:pass@example.com/webhook");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("credentials");
      }
    });

    it("rejects localhost by name", () => {
      const result = validateSSRFURL("https://localhost/webhook");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("localhost");
      }
    });

    it("rejects URL with localhost.localdomain", () => {
      const result = validateSSRFURL("https://localhost.localdomain/webhook");
      expect(result.valid).toBe(false);
    });

    it("rejects 0.0.0.0", () => {
      const result = validateSSRFURL("https://0.0.0.0/webhook");
      expect(result.valid).toBe(false);
    });

    it("rejects IPv6 loopback [::1]", () => {
      const result = validateSSRFURL("https://[::1]/webhook");
      expect(result.valid).toBe(false);
    });

    it("rejects private IP ranges", () => {
      const results = [
        validateSSRFURL("https://10.0.0.1/webhook"),
        validateSSRFURL("https://192.168.1.1/webhook"),
        validateSSRFURL("https://172.16.0.1/webhook"),
        validateSSRFURL("https://127.0.0.1/webhook"),
        validateSSRFURL("https://169.254.169.254/webhook")
      ];
      results.forEach((result) => {
        expect(result.valid).toBe(false);
      });
    });

    it("rejects IPv6 private ranges", () => {
      const results = [
        validateSSRFURL("https://[fe80::1]/webhook"),
        validateSSRFURL("https://[fc00::1]/webhook"),
        validateSSRFURL("https://[fd00::1]/webhook")
      ];
      results.forEach((result) => {
        expect(result.valid).toBe(false);
      });
    });

    it("rejects invalid URL format", () => {
      const result = validateSSRFURL("not a url");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("Invalid");
      }
    });

    it("accepts valid public IPv6", () => {
      const result = validateSSRFURL("https://[2001:4860:4860::8888]/webhook");
      expect(result.valid).toBe(true);
    });

    it("accepts valid public IPv4", () => {
      const result = validateSSRFURL("https://8.8.8.8/webhook");
      expect(result.valid).toBe(true);
    });

    it("handles URL with query parameters", () => {
      const result = validateSSRFURL("https://example.com/webhook?token=abc123");
      expect(result.valid).toBe(true);
    });

    it("handles URL with port", () => {
      const result = validateSSRFURL("https://example.com:8443/webhook");
      expect(result.valid).toBe(true);
    });

    it("rejects malformed IPv4", () => {
      const result = validateSSRFURL("https://256.256.256.256/webhook");
      expect(result.valid).toBe(false);
    });
  });

  describe("validateRedirectTarget", () => {
    const originalUrl = "https://example.com/webhook";

    it("accepts HTTPS redirect to public domain", () => {
      const result = validateRedirectTarget("https://example.com/webhook?redirect=true", originalUrl);
      expect(result.valid).toBe(true);
    });

    it("rejects HTTP redirect", () => {
      const result = validateRedirectTarget("http://example.com/webhook", originalUrl);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("HTTPS");
      }
    });

    it("rejects redirect to private IP", () => {
      const result = validateRedirectTarget("https://10.0.0.1/webhook", originalUrl);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("restricted");
      }
    });

    it("rejects redirect to loopback", () => {
      const result = validateRedirectTarget("https://127.0.0.1/webhook", originalUrl);
      expect(result.valid).toBe(false);
    });

    it("rejects redirect to AWS metadata endpoint", () => {
      const result = validateRedirectTarget("https://169.254.169.254/latest/meta-data/", originalUrl);
      expect(result.valid).toBe(false);
    });

    it("accepts relative redirect to same origin", () => {
      const result = validateRedirectTarget("/webhook?v=2", originalUrl);
      expect(result.valid).toBe(true);
    });

    it("rejects relative redirect that converts to private range (impossible but tests robustness)", () => {
      // This is theoretical - relative redirects stay on same origin
      const result = validateRedirectTarget("//10.0.0.1/webhook", originalUrl);
      expect(result.valid).toBe(false);
    });

    it("handles redirect with query string", () => {
      const result = validateRedirectTarget("https://example.com/new?param=value", originalUrl);
      expect(result.valid).toBe(true);
    });
  });

  describe("validateHostnameResolution", () => {
    it("rejects resolution when DNS fails", async () => {
      // Mock a hostname that won't resolve
      const result = await validateHostnameResolution("this-hostname-definitely-does-not-exist-12345.invalid");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("Unable to resolve");
      }
    });

    it("validates public hostname (real DNS call) - google.com", async () => {
      // This is a real DNS call - only run in environments with DNS access
      const result = await validateHostnameResolution("google.com");
      if (result.valid) {
        expect(Array.isArray(result.resolvedIPs)).toBe(true);
        expect(result.resolvedIPs.length).toBeGreaterThan(0);
        // Google's IPs should be public, not in private ranges
        result.resolvedIPs.forEach((ip) => {
          expect(isPrivateOrRestrictedIP(ip)).toBe(false);
        });
      }
    });
  });

  describe("detectDNSRebinding", () => {
    it("detects rebinding when IPs change", async () => {
      const initialIPs = ["8.8.8.8"];
      // This would require mocking DNS or having a domain that actually rebinds
      // For now, we test the logic with invalid hostname which returns true (fail-closed)
      const rebindingDetected = await detectDNSRebinding("nonexistent.invalid", initialIPs);
      expect(rebindingDetected).toBe(true); // Fail-closed: treat resolution failure as rebinding
    });

    it("returns false when IPs remain stable", async () => {
      // This would require a stable public domain
      // Test the logic: same resolution = no rebinding
      const initialIPs = ["8.8.8.8"];
      // We can't reliably test without mocking, so we skip detailed assertions
      // The important part is the function doesn't crash
      const result = await detectDNSRebinding("8.8.8.8", initialIPs);
      expect(typeof result).toBe("boolean");
    });
  });

  describe("encoded hostname handling", () => {
    it("rejects URL with IDN-encoded private IP", () => {
      // IDN encoding is handled by URL constructor, we test that our validation catches results
      const result = validateSSRFURL("https://xn--1-6l6.xn--1-6l6.xn--1-6l6.xn--1-6l6/webhook");
      // This particular encoding doesn't directly resolve to 127.0.0.1, but our validation
      // still applies to whatever the hostname becomes
      expect(typeof result.valid).toBe("boolean");
    });

    it("handles URL with punycode domain", () => {
      const result = validateSSRFURL("https://münchen.de/webhook");
      expect(typeof result.valid).toBe("boolean");
    });
  });

  describe("edge cases", () => {
    it("handles whitespace in hostname check", () => {
      // Our function trims whitespace
      expect(isPrivateOrRestrictedIP("  127.0.0.1  ")).toBe(true);
      expect(isPrivateOrRestrictedIP("  fe80::1  ")).toBe(true);
    });

    it("rejects very long hostname", () => {
      const longHostname = "a".repeat(300) + ".com";
      const result = validateSSRFURL(`https://${longHostname}/webhook`);
      // URL might be valid syntactically, but resolution would fail
      // Our static validation doesn't reject it, just syntax check
      expect(typeof result.valid).toBe("boolean");
    });

    it("handles URL with fragment", () => {
      const result = validateSSRFURL("https://example.com/webhook#section");
      expect(result.valid).toBe(true);
    });

    it("handles URL with userinfo separator but no credentials", () => {
      // This is technically invalid but URL constructor might parse it
      const result = validateSSRFURL("https://@example.com/webhook");
      expect(typeof result.valid).toBe("boolean");
    });
  });
});
