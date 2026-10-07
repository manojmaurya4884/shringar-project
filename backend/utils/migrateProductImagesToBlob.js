/**
 * One-time migration: legacy Product.imageUrl values under
 *   /uploads/products/...
 * → durable public Vercel Blob URLs.
 *
 * Run from the backend directory:
 *   npm run migrate:product-images
 *
 * Safe to re-run:
 * - Products that already have HTTPS/Blob URLs are not selected / are skipped.
 * - Blob pathname is deterministic from the legacy filename; an existing Blob
 *   is reused via head() instead of uploading a duplicate.
 *
 * Does NOT change normal product create/update/delete upload logic.
 * Does NOT delete local files or the /uploads static mount.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { put, head, BlobNotFoundError } = require('@vercel/blob');

const connectDB = require('../config/db');
const Product = require('../models/Product');

const LEGACY_PREFIX = '/uploads/products/';
const LOCAL_DIR = path.join(__dirname, '..', 'uploads', 'products');

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function isNotFoundError(err) {
  return (
    err instanceof BlobNotFoundError ||
    err?.name === 'BlobNotFoundError' ||
    /not found|404/i.test(err?.message || '')
  );
}

/**
 * Resolve a public Blob URL for a deterministic pathname.
 * Reuses an existing object when present; otherwise uploads once.
 */
async function resolveBlobUrl(pathname, buffer, contentType) {
  try {
    const existing = await head(pathname);
    if (existing?.url) {
      return { url: existing.url, reused: true };
    }
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
  }

  const blob = await put(pathname, buffer, {
    access: 'public',
    contentType,
    addRandomSuffix: false,
  });

  return { url: blob.url, reused: false };
}

async function migrate() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set in your .env file');
    process.exit(1);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('❌ BLOB_READ_WRITE_TOKEN is not set in your .env file');
    process.exit(1);
  }

  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    console.error('❌ MongoDB is not connected. Aborting migration.');
    process.exit(1);
  }

  const products = await Product.find({
    imageUrl: { $regex: `^${LEGACY_PREFIX.replace(/\//g, '\\/')}` },
  });

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  const total = products.length;

  console.log(
    `\nFound ${total} legacy product(s) with imageUrl starting with ${LEGACY_PREFIX}\n`
  );

  for (const product of products) {
    const id = product._id.toString();
    const name = product.name || '(unnamed)';
    const oldUrl = product.imageUrl;
    let filename = '(unknown)';

    try {
      if (isHttpUrl(oldUrl)) {
        skipped += 1;
        console.log(`[SKIPPED] ${id} | ${name}`);
        console.log(`  old:    ${oldUrl}`);
        console.log(`  local:  (n/a)`);
        console.log(`  blob:   (n/a)`);
        console.log(`  status: already an HTTPS/Blob URL\n`);
        continue;
      }

      if (typeof oldUrl !== 'string' || !oldUrl.startsWith(LEGACY_PREFIX)) {
        skipped += 1;
        console.log(`[SKIPPED] ${id} | ${name}`);
        console.log(`  old:    ${oldUrl}`);
        console.log(`  local:  (n/a)`);
        console.log(`  blob:   (n/a)`);
        console.log(`  status: not a legacy ${LEGACY_PREFIX} path\n`);
        continue;
      }

      filename = path.basename(oldUrl);
      const localPath = path.join(LOCAL_DIR, filename);

      if (!fs.existsSync(localPath)) {
        failed += 1;
        console.log(`[FAILED] ${id} | ${name}`);
        console.log(`  old:    ${oldUrl}`);
        console.log(`  local:  ${filename}`);
        console.log(`  blob:   (none)`);
        console.log(`  status: local file not found at ${localPath}\n`);
        continue;
      }

      const buffer = fs.readFileSync(localPath);
      if (!buffer.length) {
        failed += 1;
        console.log(`[FAILED] ${id} | ${name}`);
        console.log(`  old:    ${oldUrl}`);
        console.log(`  local:  ${filename}`);
        console.log(`  blob:   (none)`);
        console.log(`  status: local file is empty\n`);
        continue;
      }

      const contentType = contentTypeFor(filename);
      // Deterministic pathname derived from the legacy filename (e.g. products/product-….jpg)
      const pathname = `products/${filename}`;

      const { url: blobUrl, reused } = await resolveBlobUrl(
        pathname,
        buffer,
        contentType
      );

      // Update MongoDB only after Blob URL is resolved successfully
      product.imageUrl = blobUrl;
      await product.save();

      migrated += 1;
      console.log(`[MIGRATED] ${id} | ${name}`);
      console.log(`  old:    ${oldUrl}`);
      console.log(`  local:  ${filename}`);
      console.log(`  blob:   ${blobUrl}`);
      console.log(
        `  status: ${reused ? 'reused existing Blob object' : 'uploaded new Blob object'}\n`
      );
    } catch (err) {
      failed += 1;
      console.log(`[FAILED] ${id} | ${name}`);
      console.log(`  old:    ${oldUrl}`);
      console.log(`  local:  ${filename}`);
      console.log(`  blob:   (none)`);
      console.log(`  status: ${err.message || err}\n`);
    }
  }

  console.log('--- Migration summary ---');
  console.log(`total legacy products found: ${total}`);
  console.log(`successfully migrated:       ${migrated}`);
  console.log(`skipped:                     ${skipped}`);
  console.log(`failed:                      ${failed}`);

  await mongoose.disconnect();
  console.log('\nMongoDB disconnected');

  if (failed > 0) {
    process.exit(1);
  }
}

migrate().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore disconnect errors during fatal exit
  }
  process.exit(1);
});
