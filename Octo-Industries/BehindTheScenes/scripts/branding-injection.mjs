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

  if (!hasBrandingAsset(html, 'game-branding.css', 'href', launchFile, root)) {
    assets.push(`<link rel="stylesheet" href="${assetReference(launchFile, resolve(brandingDirectory, 'game-branding.css'))}">`);
  }
  if (!hasBrandingAsset(html, 'game-branding.js', 'src', launchFile, root)) {
    assets.push(`<script defer src="${assetReference(launchFile, resolve(brandingDirectory, 'game-branding.js'))}"></script>`);
  }
  if (!assets.length) return html;

  const markup = `\n    ${assets.join('\n    ')}\n  `;
  if (/<\/head\s*>/i.test(html)) {
    return html.replace(/<\/head\s*>/i, `${markup}</head>`);
  }
  if (/<body\b[^>]*>/i.test(html)) {
    return html.replace(/<body\b[^>]*>/i, (openingTag) => `${openingTag}${markup}`);
  }
  return `${markup}${html}`;
}
