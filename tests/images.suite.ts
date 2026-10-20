import { TEST_DATA_DIR } from "./env";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { seedIfEmpty } from "../server/seed";
import { run, get, UPLOAD_DIR } from "../server/db";
import { backfillVariants, bestVariant, invalidateMediaCache, makeVariants, srcsetFor } from "../server/images";
import { renderLayout } from "../server/render/widgets";
import { newCtx } from "../server/render/site";
import { renderLiquid } from "../server/render/liquid";
import { makeSection, makeWidget } from "../shared/widgets";

before(() => {
  seedIfEmpty();
});

async function addJpeg(name: string, width: number, height: number) {
  const filename = `${name}.jpg`;
  await sharp({ create: { width, height, channels: 3, background: "#e60000" } }).jpeg().toFile(path.join(UPLOAD_DIR, filename));
  const id = run("INSERT INTO media(folder, filename, original_name, mime, size, width, height) VALUES('', ?, ?, 'image/jpeg', 1, ?, ?)", filename, filename, width, height).lastId;
  return { id, filename, url: `/media/${filename}` };
}

describe("responsive images", () => {
  it("creates WebP copies narrower than the original only", async () => {
    const { filename } = await addJpeg("wide", 2000, 1000);
    const v = await makeVariants(filename, "image/jpeg", 2000);
    assert.deepEqual(v.map((x) => x.w), [480, 960, 1600]);
    for (const x of v) {
      const meta = await sharp(path.join(UPLOAD_DIR, x.file)).metadata();
      assert.equal(meta.format, "webp");
      assert.equal(meta.width, x.w);
    }
    assert.deepEqual(await makeVariants(filename, "image/svg+xml", 2000), [], "vector images are left alone");
  });

  it("backfills older uploads and builds srcset", async () => {
    const { url } = await addJpeg("older", 1200, 800);
    assert.equal(srcsetFor(url), "");
    assert.ok((await backfillVariants()) >= 1);
    invalidateMediaCache();
    assert.equal(srcsetFor(url), "/media/older-w480.webp 480w, /media/older-w960.webp 960w, /media/older.jpg 1200w");
    assert.equal(bestVariant(url, 900), "/media/older-w960.webp");
    assert.equal(bestVariant("https://example.com/x.jpg"), "https://example.com/x.jpg", "external images pass through");
  });

  it("renders srcset, sizes, intrinsic size and the focal point", async () => {
    const { id, url } = await addJpeg("hero", 2400, 1200);
    await backfillVariants();
    run("UPDATE media SET focal = '30% 20%' WHERE id = ?", id);
    invalidateMediaCache();
    const html = await renderLayout({ sections: [makeSection([6, 6], [[makeWidget("image", { src: url, alt: "Red" })], []])] }, newCtx("/", false));
    assert.match(html, /srcset="\/media\/hero-w480\.webp 480w, \/media\/hero-w960\.webp 960w, \/media\/hero-w1600\.webp 1600w, \/media\/hero\.jpg 2400w"/);
    assert.match(html, /sizes="\(max-width: 860px\) 100vw, 564px"/, "half of the 1128px container");
    assert.match(html, /width="2400" height="1200"/);
    assert.match(html, /object-position:30% 20%/);
  });

  it("uses a resized copy and the focal point for background images", async () => {
    const { url } = await addJpeg("bg", 3000, 1500);
    await backfillVariants();
    run("UPDATE media SET focal = '70% 40%' WHERE filename = 'bg.jpg'");
    invalidateMediaCache();
    const html = await renderLayout({ sections: [makeSection([12], [[makeWidget("hero", { title: "Hi", image: url })]])] }, newCtx("/", false));
    assert.match(html, /background-image:url\(&#39;\/media\/bg-w1600\.webp&#39;\);background-position:70% 40%/);
  });

  it("offers srcset and image_url filters to Liquid templates", async () => {
    const out = await renderLiquid(`{{ u | srcset }}|{{ u | image_url: 400 }}`, { u: "/media/older.jpg" });
    assert.match(out, /^\/media\/older-w480\.webp 480w/);
    assert.match(out, /\|\/media\/older-w480\.webp$/);
  });

  it("keeps the data dir isolated", () => {
    assert.ok(UPLOAD_DIR.startsWith(TEST_DATA_DIR));
    assert.ok(fs.existsSync(path.join(UPLOAD_DIR, "older-w960.webp")));
    assert.equal(get("SELECT variants FROM media WHERE filename = 'older.jpg'").variants.includes("older-w960.webp"), true);
  });
});
