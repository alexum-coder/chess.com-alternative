#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createGzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const bucket = process.env.STOCKFISH_NATIVE_BUCKET || 'stockfish-native';
const objectName = process.env.STOCKFISH_NATIVE_OBJECT || 'stockfish-linux-x64.gz';
const maxUploadMb = Math.max(1, Number(process.env.STOCKFISH_NATIVE_MAX_UPLOAD_MB) || 50);
// Keep a margin below the project's maximum per-object upload size.
const requestedPartMb = Math.max(1, Number(process.env.STOCKFISH_NATIVE_PART_SIZE_MB) || 45);
const partSizeMb = Math.min(requestedPartMb, Math.max(1, maxUploadMb - 1));

async function main() {
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your local .env before uploading.');
  }
  const inputPath = path.resolve(process.argv[2] || process.env.STOCKFISH_NATIVE_LOCAL_PATH || '');
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error('Pass the path to a Linux Stockfish executable: npm run upload:stockfish-native -- ./path/to/stockfish');
  }
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(inputPath, 'r');
  try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (magic[0] !== 0x7f || magic.toString('ascii', 1, 4) !== 'ELF') {
    throw new Error('This is not a Linux ELF executable. Do not upload your Windows .exe: Render runs Linux. Download the Linux x86-64 Stockfish binary first.');
  }

  const tempPath = path.join(os.tmpdir(), `zugzwang-stockfish-${process.pid}.gz`);
  try {
    console.log(`Compressing ${path.basename(inputPath)}…`);
    await pipeline(fs.createReadStream(inputPath), createGzip({ level: 9 }), fs.createWriteStream(tempPath));
    const compressedSize = fs.statSync(tempPath).size;
    const maxBytes = maxUploadMb * 1_000_000; // Storage's MB limit is decimal.
    const partBytes = partSizeMb * 1024 * 1024;
    const partCount = Math.ceil(compressedSize / partBytes);
    console.log(`Compressed size: ${(compressedSize / 1024 / 1024).toFixed(2)} MiB`);
    console.log(`Splitting into ${partCount} Storage object(s) of at most ${partSizeMb} MiB each.`);
    if (partBytes >= maxBytes) {
      throw new Error('Part size must be smaller than the configured per-file upload limit.');
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const bucketOptions = {
      public: false,
      fileSizeLimit: `${maxUploadMb}MB`,
      allowedMimeTypes: ['application/gzip']
    };
    const { data: existingBucket, error: lookupError } = await supabase.storage.getBucket(bucket);
    if (lookupError) {
      const notFound = lookupError.statusCode === '404' || lookupError.status === 404
        || /not found|does not exist/i.test(lookupError.message || '');
      if (!notFound) throw new Error(`Could not inspect private bucket "${bucket}": ${lookupError.message}`);
      const { error } = await supabase.storage.createBucket(bucket, bucketOptions);
      if (error) throw new Error(`Could not create private bucket "${bucket}": ${error.message}`);
      console.log(`Created private Storage bucket: ${bucket}`);
    } else {
      if (existingBucket?.public) {
        const { error } = await supabase.storage.updateBucket(bucket, { public: false });
        if (error) throw new Error(`Could not make bucket "${bucket}" private: ${error.message}`);
        console.log(`Made Storage bucket "${bucket}" private.`);
      }
      const { error } = await supabase.storage.updateBucket(bucket, {
        public: false,
        fileSizeLimit: `${maxUploadMb}MB`,
        allowedMimeTypes: ['application/gzip']
      });
      if (error) throw new Error(`Could not configure private bucket "${bucket}": ${error.message}`);
    }

    const storage = supabase.storage.from(bucket);
    const handle = await fs.promises.open(tempPath, 'r');
    const uploadedObjects = [];
    try {
      for (let index = 0, offset = 0; offset < compressedSize; index += 1) {
        const length = Math.min(partBytes, compressedSize - offset);
        const body = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(body, 0, length, offset);
        if (bytesRead !== length) throw new Error(`Could not read compressed engine part ${index + 1}.`);
        const partName = `${objectName}.part-${String(index + 1).padStart(3, '0')}`;
        if (body.length > maxBytes) throw new Error(`${partName} exceeds the ${maxUploadMb} MiB per-file limit.`);
        const { error } = await storage.upload(partName, body, {
          upsert: true,
          contentType: 'application/gzip',
          cacheControl: '31536000'
        });
        if (error) throw new Error(`Upload failed for ${partName}: ${error.message}`);
        uploadedObjects.push(partName);
        console.log(`Uploaded ${partName} (${(body.length / 1024 / 1024).toFixed(2)} MiB)`);
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }

    console.log(`\nUploaded ${uploadedObjects.length} compressed part(s) to private bucket "${bucket}".`);
    console.log('\nSet these variables in Render:');
    console.log(`STOCKFISH_NATIVE_BUCKET=${bucket}`);
    console.log(`STOCKFISH_NATIVE_OBJECTS=${uploadedObjects.join(',')}`);
    console.log('\nThe server downloads the parts in this exact order, concatenates the gzip stream, and decompresses it.');
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

main().catch((error) => {
  console.error('\nNative Stockfish upload failed:', error.message || error);
  process.exitCode = 1;
});
