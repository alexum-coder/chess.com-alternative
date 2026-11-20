#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const bucket = process.env.STOCKFISH_STORAGE_BUCKET || 'stockfish';
const assetTypes = { js: 'text/javascript', wasm: 'application/wasm' };

async function main() {
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your local .env before uploading.');
  }

  const stockfishPackage = require('stockfish');
  if (typeof stockfishPackage.findEngine !== 'function') {
    throw new Error('The installed stockfish package does not expose findEngine(). Run npm install stockfish@19.0.1 --save-exact.');
  }
  const engineJsPath = path.resolve(stockfishPackage.findEngine('lite-single'));
  const engineJsName = path.basename(engineJsPath);
  const engineWasmName = engineJsName.replace(/\.js$/i, '.wasm');
  const assets = [
    { name: engineJsName, contentType: assetTypes.js, filePath: engineJsPath },
    { name: engineWasmName, contentType: assetTypes.wasm, filePath: path.join(path.dirname(engineJsPath), engineWasmName) }
  ].map((asset) => {
    if (!fs.existsSync(asset.filePath)) {
      throw new Error(`Missing ${asset.filePath}. The stockfish package returned this engine path via findEngine('lite-single'), but its matching WASM file was not found. Reinstall stockfish@19.0.1.`);
    }
    return { ...asset, body: fs.readFileSync(asset.filePath) };
  });

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const bucketOptions = {
    public: true,
    fileSizeLimit: '10MB',
    allowedMimeTypes: ['text/javascript', 'application/javascript', 'application/wasm']
  };
  const { error: lookupError } = await supabase.storage.getBucket(bucket);
  if (lookupError) {
    const notFound = lookupError.statusCode === '404' || lookupError.status === 404
      || /not found|does not exist/i.test(lookupError.message || '');
    if (!notFound) throw new Error(`Could not inspect Storage bucket "${bucket}": ${lookupError.message}`);
    const { error } = await supabase.storage.createBucket(bucket, bucketOptions);
    if (error) throw new Error(`Could not create public bucket "${bucket}": ${error.message}`);
    console.log(`Created public Storage bucket: ${bucket}`);
  } else {
    const { error } = await supabase.storage.updateBucket(bucket, bucketOptions);
    if (error) throw new Error(`Could not configure public bucket "${bucket}": ${error.message}`);
    console.log(`Configured public Storage bucket: ${bucket}`);
  }

  const storage = supabase.storage.from(bucket);
  for (const asset of assets) {
    const { error } = await storage.upload(asset.name, asset.body, {
      upsert: true,
      contentType: asset.contentType,
      cacheControl: '31536000'
    });
    if (error) throw new Error(`Upload failed for ${asset.name}: ${error.message}`);
    const { data } = storage.getPublicUrl(asset.name);
    console.log(`Uploaded ${asset.name} (${(asset.body.length / 1024 / 1024).toFixed(2)} MiB)`);
    console.log(`  ${data.publicUrl}`);
  }

  console.log('\nStockfish browser assets are now in Supabase Storage.');
  console.log(`Set STOCKFISH_STORAGE_BUCKET=${bucket} in your Render environment.`);
}

main().catch((error) => {
  console.error('\nStockfish Storage upload failed:', error.message || error);
  process.exitCode = 1;
});
