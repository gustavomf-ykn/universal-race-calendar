import { describe, expect, it, vi } from "vitest";
import { checkStagingStorage } from "../scripts/check-staging-storage.mjs";

const env = {
  SUPABASE_URL: "https://sggrijhyblejlgimgzzc.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test_only",
};
describe("manual staging Storage preflight", () => {
  it("checks the private bucket without uploading or downloading results", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "race-exports", public: false })));
    await expect(checkStagingStorage(env, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe(`${env.SUPABASE_URL}/storage/v1/bucket/race-exports`);
    expect(request.mock.calls[0][1].redirect).toBe("error");
  });
  it("rejects another project before sending credentials", async () => {
    const request = vi.fn();
    await expect(checkStagingStorage({ ...env, SUPABASE_URL: "https://other.example" }, request)).rejects.toThrow(
      /^staging_storage_check_failed$/,
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects a denied key, public bucket or different bucket", async () => {
    for (const response of [
      new Response("secret provider body", { status: 403 }),
      new Response(JSON.stringify({ id: "race-exports", public: true })),
      new Response(JSON.stringify({ id: "another", public: false })),
    ]) {
      await expect(checkStagingStorage(env, vi.fn().mockResolvedValue(response))).rejects.toThrow(
        /^staging_storage_check_failed$/,
      );
    }
  });
  it("sanitizes transport errors", async () => {
    await expect(
      checkStagingStorage(env, vi.fn().mockRejectedValue(new Error(env.SUPABASE_SECRET_KEY))),
    ).rejects.toThrow(/^staging_storage_check_failed$/);
  });
});
