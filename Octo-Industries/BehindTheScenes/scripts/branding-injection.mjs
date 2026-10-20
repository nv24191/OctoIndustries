import { dirname, relative, resolve, sep } from 'node:path';

function assetReference(fromFile, assetFile) {
  const path = relative(resolve(fromFile, '..'), assetFile).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

function hasBrandingAsset(html, assetName, attributeName, launchFile, root) {
  const elements = attributeName === 'src'
    ? /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi
    : /<link\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  const expectedPath = resolve(root, 'Octo-Industries', 'branding', assetName);

  return Array.from(html.matchAll(elements)).some((match) => {
    const reference = match[2].split(/[?#]/, 1)[0];
    let decodedReference;
    try {
      decodedReference = decodeURIComponent(reference);
    } catch {
      return false;
    }
    const referencedPath = reference.startsWith('/')
      ? resolve(root, decodedReference.slice(1))
      : resolve(dirname(launchFile), decodedReference);
    return referencedPath === expectedPath;
  });
}

export function ensureGameBranding(html, launchFile, root) {
  const brandingDirectory = resolve(root, 'Octo-Industries/branding');
  const assets = [];
  const usesLoaderDirectly = /\bOctoLoader\.(?:show|loadRuffle)\s*\(/.test(html);
  for (const [assetName, attributeName, tagName] of [
    ['game-branding.css', 'href', 'link'],
    ['game-branding.js', 'src', 'script'],
    ['game-loader.css', 'href', 'link'],
    ['game-loader.js', 'src', 'script'],
  ]) {
    if (hasBrandingAsset(html, assetName, attributeName, launchFile, root)) continue;
    const reference = assetReference(launchFile, resolve(brandingDirectory, assetName));
    assets.push(tagName === 'link'
      ? `<link rel="stylesheet" href="${reference}">`
      : `<script defer src="${reference}"${assetName === 'game-loader.js' && !usesLoaderDirectly ? ' data-octo-auto-loader' : ''}></script>`);
  }
  let result = html;
  if (usesLoaderDirectly) return insertAssets(result, assets);

  const loaderScript = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  result = result.replace(loaderScript, (tag) => {
    if (/\bdata-octo-auto-loader\b/i.test(tag)) return tag;
    const match = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag);
    if (!match || !hasBrandingAsset(`<${tag.slice(1)}`, 'game-loader.js', 'src', launchFile, root)) return tag;
    return tag.replace(/>$/, ' data-octo-auto-loader>');
  });
  return insertAssets(result, assets)
    .replace(/\n[ \t]+\n(?=[ \t]*<(?:link|script)\b[^>\n]*game-(?:branding|loader)\.)/g, '\n');
}

function insertAssets(html, assets) {
  if (!assets.length) return html;
  const markup = `\n    ${assets.join('\n    ')}\n`;
  if (/<\/head\s*>/i.test(html)) {
    return html.replace(/<\/head\s*>/i, `${markup}</head>`);
  }
  if (/<body\b[^>]*>/i.test(html)) {
    return html.replace(/<body\b[^>]*>/i, (openingTag) => `${openingTag}${markup}`);
  }
  return `${markup}${html}`;
}
