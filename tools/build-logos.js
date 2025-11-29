/* tools/build-logos.js
 * Build step: read all *.svg from R2 bucket and (re)generate matching *.png in the same bucket.
 * Idempotent: skips PNGs newer than their SVG source.
 * Requires env: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_LOGOS (podfy-logos)
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Resvg } from "@resvg/resvg-js";

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET_LOGOS || "podfy-logos";

if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error("Missing R2 env. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.");
  process.exit(1);
}

 const s3 = new S3Client({
   region: "auto",
   endpoint: R2_ENDPOINT,        // e.g. https://<accountid>.r2.cloudflarestorage.com
   forcePathStyle: true,         // <-- IMPORTANT for R2 signing
   credentials: {
     accessKeyId: R2_ACCESS_KEY_ID,
     secretAccessKey: R2_SECRET_ACCESS_KEY,
   },
 });

async function streamToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  const arr = await new Response(body).arrayBuffer();
  return Buffer.from(arr);
}

async function listAllSvgs(prefix = "") {
  const out = [];
  let ContinuationToken;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken }));
    for (const o of res.Contents || []) {
      if (o.Key && o.Key.toLowerCase().endsWith(".svg")) out.push({ Key: o.Key, LastModified: o.LastModified });
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

async function head(key) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    return null;
  }
}

async function buildPng(svgKey) {
  const pngKey = svgKey.replace(/\.svg$/i, ".png");

  const pngHead = await head(pngKey);
  const svgHead = await head(svgKey);

  // Skip if PNG exists and is not older than SVG
  if (pngHead && svgHead && pngHead.LastModified >= svgHead.LastModified) {
    console.log(`✓ up to date: ${pngKey}`);
    return;
  }

  const svgObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: svgKey }));
  const svgBuf = await streamToBuffer(svgObj.Body);

  // Render PNG (adjust width to your preferred max badge height/width)
  const resvg = new Resvg(svgBuf, { fitTo: { mode: "height", value: 56 } });
  const png = resvg.render().asPng();

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: pngKey,
    Body: png,
    ContentType: "image/png",
    CacheControl: "public, max-age=31536000, immutable"
  }));

  console.log(`→ built: ${pngKey}`);
}

(async function main() {
  console.log(`Listing *.svg in ${BUCKET} …`);
  const svgs = await listAllSvgs("");
  if (!svgs.length) {
    console.log("No SVGs found.");
    return;
  }

  // Small concurrency
  const queue = svgs.slice();
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const { Key } = queue.shift();
      try {
        await buildPng(Key);
      } catch (e) {
        console.error(`✗ Failed to convert ${Key}: ${e?.message || e}`);
      }
    }
  });
  await Promise.all(workers);
  console.log("Finished");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
